import fs from 'fs';
import path from 'path';

const TOKEN_DIR = process.env.TOKEN_DIR || '/var/www/instrumenta/data/session_tokens/';
const USERS_FILE = process.env.USERS_FILE || '/var/www/users.json';
const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS === 'true';

// Cache for users.json to avoid repeated file reads
let usersCache = null;
let usersCacheTime = 0;
const USERS_CACHE_TTL = 5000; // 5 seconds

/**
 * Read users.json with caching.
 * @returns {Object|null}
 */
function getUsers() {
    const now = Date.now();
    if (usersCache && (now - usersCacheTime) < USERS_CACHE_TTL) {
        return usersCache;
    }
    try {
        const raw = fs.readFileSync(USERS_FILE, 'utf8');
        usersCache = JSON.parse(raw);
        usersCacheTime = now;
        return usersCache;
    } catch {
        return null;
    }
}

/**
 * Validate an API key against users.json.
 * API keys are stored in users.json under each user's 'api_key' field.
 * @param {string} token
 * @returns {{ username: string }|null}
 */
function validateApiKey(token) {
    const users = getUsers();
    if (!users) return null;

    for (const [username, userData] of Object.entries(users)) {
        if (userData.api_key && hashEquals(userData.api_key, token)) {
            return { username };
        }
    }
    return null;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function hashEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Validate a session token file.
 * Reads the token file from TOKEN_DIR/{token} which contains JSON: { username, expires }
 * @param {string} token
 * @returns {{ username: string }|null}
 */
function validateSessionToken(token) {
    try {
        const filePath = path.join(TOKEN_DIR, token);
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);

        if (!data.username || !data.expires) return null;

        // Check expiry (PHP stores as Unix seconds)
        if (data.expires < Math.floor(Date.now() / 1000)) {
            console.warn(`[auth] Token for ${data.username} expired`);
            return null;
        }

        return { username: data.username };
    } catch {
        return null;
    }
}

/**
 * Validate a Bearer token.
 * Supports both session tokens and API keys.
 *
 * Priority:
 * 1. Session token (file in TOKEN_DIR)
 * 2. API key (stored in users.json)
 *
 * @param {string|null} token
 * @returns {{ username: string }|null}
 */
export function validateToken(token) {
    if (!token || typeof token !== 'string') {
        return ALLOW_ANONYMOUS ? { username: 'anonymous' } : null;
    }

    // Sanitize — token must be a hex string (64 chars)
    if (!/^[a-f0-9]{64}$/i.test(token)) {
        return ALLOW_ANONYMOUS ? { username: 'anonymous' } : null;
    }

    // 1. Try session token first
    const sessionResult = validateSessionToken(token);
    if (sessionResult) return sessionResult;

    // 2. Try API key
    const apiKeyResult = validateApiKey(token);
    if (apiKeyResult) return apiKeyResult;

    return ALLOW_ANONYMOUS ? { username: 'anonymous' } : null;
}
