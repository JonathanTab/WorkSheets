<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sign In</title>

    <style>
        :root {
            --bg: #0f172a;
            --card: #111827;
            --accent: #3b82f6;
            --text: #e5e7eb;
            --muted: #9ca3af;
            --error: #ef4444;
            --success: #22c55e;
        }

        * {
            box-sizing: border-box;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        }

        body {
            margin: 0;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
        }

        .login-card {
            width: 100%;
            max-width: 360px;
            background: var(--card);
            padding: 24px;
            border-radius: 14px;
            box-shadow: 0 20px 40px rgba(0,0,0,.4);
        }

        h1 {
            margin: 0 0 4px;
            font-size: 1.5rem;
        }

        .subtitle {
            margin: 0 0 20px;
            color: var(--muted);
            font-size: 0.9rem;
        }

        label {
            font-size: 0.85rem;
            color: var(--muted);
            display: block;
            margin-bottom: 6px;
        }

        input {
            width: 100%;
            padding: 12px;
            border-radius: 10px;
            border: none;
            margin-bottom: 14px;
            font-size: 1rem;
            background: #020617;
            color: var(--text);
            outline: none;
        }

        input:focus {
            outline: 2px solid var(--accent);
        }

        button {
            width: 100%;
            padding: 12px;
            border-radius: 10px;
            border: none;
            font-size: 1rem;
            background: var(--accent);
            color: white;
            cursor: pointer;
            transition: opacity 0.2s;
        }

        button:disabled {
            opacity: 0.7;
            cursor: not-allowed;
        }

        .error {
            color: var(--error);
            font-size: 0.85rem;
            margin-top: 10px;
            display: none;
        }

        .success {
            color: var(--success);
            font-size: 0.85rem;
            margin-top: 10px;
            display: none;
        }

        .footer {
            text-align: center;
            margin-top: 14px;
            font-size: 0.75rem;
            color: var(--muted);
        }

        .toggle-link {
            text-align: center;
            margin-top: 14px;
            font-size: 0.85rem;
            color: var(--accent);
            cursor: pointer;
            background: none;
            border: none;
            padding: 0;
            text-decoration: underline;
        }

        .toggle-link:hover {
            color: #60a5fa;
        }

        .hidden {
            display: none !important;
        }

        .password-requirements {
            font-size: 0.75rem;
            color: var(--muted);
            margin-top: -10px;
            margin-bottom: 14px;
        }
    </style>
</head>
<body>

<div class="login-card">
    <!-- Login Form -->
    <div id="loginSection">
        <h1>Sign In</h1>
        <p class="subtitle">Access Instrumenta tools</p>

        <form id="loginForm">
            <label for="username">Username</label>
            <input id="username" autocorrect="off" autocapitalize="off" name="username" required autocomplete="username">

            <label for="password">Password</label>
            <input id="password" type="password" name="password" autocomplete="current-password">

            <button type="submit">Login</button>

            <div class="error" id="errorBox"></div>
        </form>

        <button class="toggle-link" id="showRegister">Create an account</button>
    </div>

    <!-- Register Form -->
    <div id="registerSection" class="hidden">
        <h1>Create Account</h1>
        <p class="subtitle">Join Instrumenta</p>

        <form id="registerForm">
            <label for="regUsername">Username</label>
            <input id="regUsername" autocorrect="off" autocapitalize="off" name="username" required autocomplete="username" placeholder="3-20 characters">

            <label for="regPassword">Password</label>
            <input id="regPassword" type="password" name="password" required autocomplete="new-password" placeholder="At least 8 characters">
            <div class="password-requirements">Letters, numbers, and underscores only</div>

            <label for="regConfirmPassword">Confirm Password</label>
            <input id="regConfirmPassword" type="password" name="confirm_password" required autocomplete="new-password">

            <button type="submit">Create Account</button>

            <div class="error" id="regErrorBox"></div>
            <div class="success" id="regSuccessBox"></div>
        </form>

        <button class="toggle-link" id="showLogin">Already have an account? Sign in</button>
    </div>

    <div class="footer">
        Instrumenta.cf
    </div>
</div>

<script>
    const loginSection = document.getElementById('loginSection');
    const registerSection = document.getElementById('registerSection');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const errorBox = document.getElementById('errorBox');
    const regErrorBox = document.getElementById('regErrorBox');
    const regSuccessBox = document.getElementById('regSuccessBox');

    document.getElementById('showRegister').addEventListener('click', () => {
        loginSection.classList.add('hidden');
        registerSection.classList.remove('hidden');
        regErrorBox.style.display = 'none';
        regSuccessBox.style.display = 'none';
    });

    document.getElementById('showLogin').addEventListener('click', () => {
        registerSection.classList.add('hidden');
        loginSection.classList.remove('hidden');
        errorBox.style.display = 'none';
    });

    function getRedirectTarget() {
        const params = new URLSearchParams(window.location.search);
        const redirect = params.get('redirect');

        // Security: only allow same-site relative redirects
        if (redirect && redirect.startsWith('/')) {
            return redirect;
        }

        return '/';
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorBox.style.display = 'none';
        loginForm.querySelector('button').disabled = true;

        const username = loginForm.username.value;
        const password = loginForm.password.value;

        try {
            const res = await fetch('/api/auth.php?action=login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (data.success) {
                if (window.opener) {
                    window.opener.postMessage({
                        type: 'AUTH_SUCCESS',
                        token: data.token,   // use as Authorization: Bearer
                        apikey: data.apikey  // deprecated alias, kept for compat
                    }, window.location.origin);

                    window.close();
                    return;
                }

                // Fallback: same-window navigation
                window.location.href = getRedirectTarget();
            } else {
                errorBox.textContent = data.error || 'Login failed';
                errorBox.style.display = 'block';
            }
        } catch {
            errorBox.textContent = 'Network error';
            errorBox.style.display = 'block';
        } finally {
            loginForm.querySelector('button').disabled = false;
        }
    });

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        regErrorBox.style.display = 'none';
        regSuccessBox.style.display = 'none';
        const submitBtn = registerForm.querySelector('button');
        submitBtn.disabled = true;

        const username = registerForm.username.value;
        const password = registerForm.password.value;
        const confirmPassword = registerForm.confirm_password.value;

        // Client-side validation
        if (password !== confirmPassword) {
            regErrorBox.textContent = 'Passwords do not match';
            regErrorBox.style.display = 'block';
            submitBtn.disabled = false;
            return;
        }

        try {
            const res = await fetch('/api/auth.php?action=register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (data.success) {
                regSuccessBox.textContent = 'Account created! Logging you in...';
                regSuccessBox.style.display = 'block';

                // Auto-login after registration
                setTimeout(async () => {
                    try {
                        const loginRes = await fetch('/api/auth.php?action=login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ username, password })
                        });

                        const loginData = await loginRes.json();

                        if (loginData.success) {
                            if (window.opener) {
                                window.opener.postMessage({
                                    type: 'AUTH_SUCCESS',
                                    token: loginData.token,
                                    apikey: loginData.apikey
                                }, window.location.origin);
                                window.close();
                                return;
                            }
                            window.location.href = getRedirectTarget();
                        } else {
                            // Registration succeeded but auto-login failed
                            // Switch to login form so user can try manually
                            registerSection.classList.add('hidden');
                            loginSection.classList.remove('hidden');
                            loginForm.username.value = username;
                            errorBox.textContent = 'Account created! Please login with your new credentials.';
                            errorBox.style.display = 'block';
                        }
                    } catch {
                        registerSection.classList.add('hidden');
                        loginSection.classList.remove('hidden');
                        loginForm.username.value = username;
                        errorBox.textContent = 'Account created! Please login manually.';
                        errorBox.style.display = 'block';
                    }
                }, 1000);
            } else {
                regErrorBox.textContent = data.error || 'Registration failed';
                regErrorBox.style.display = 'block';
            }
        } catch {
            regErrorBox.textContent = 'Network error';
            regErrorBox.style.display = 'block';
        } finally {
            submitBtn.disabled = false;
        }
    });
</script>


</body>
</html>
