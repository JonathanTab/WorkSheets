/**
 * auth.js — credential validation for the Yjs server.
 *
 * This used to be a private re-implementation: it read token files straight
 * out of the session-token directory and checked `expires` itself. That meant
 * two copies of the rules, and they disagreed — the PHP side rotates tokens
 * and marks the predecessor `superseded_by`, which this file knew nothing
 * about, so a token PHP considered perfectly valid was rejected here.
 *
 * It now asks the PHP validator (api/validate.php) over the loopback vhost, so
 * there is exactly one implementation of "is this credential good" and the
 * on-disk token format is free to change without silently breaking realtime
 * sync.
 *
 * Accepts all three credential kinds: session cookies, PWA device tokens, and
 * API keys — resolving which is which is the validator's job, not ours.
 */

const VALIDATE_URL = process.env.VALIDATE_URL || 'http://127.0.0.1/api/validate.php';
const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS === 'true';

/** Cache hits briefly: a reconnect storm should not become a PHP request storm. */
const POSITIVE_TTL_MS = 60_000;
/** Cache misses too, so a client looping on a dead token cannot amplify load. */
const NEGATIVE_TTL_MS = 10_000;
/** Bound the cache so a flood of junk tokens cannot grow it without limit. */
const MAX_CACHE_ENTRIES = 5000;

/** @type {Map<string, {value: object|null, expires: number}>} */
const cache = new Map();

function cacheGet(token) {
    const hit = cache.get(token);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
        cache.delete(token);
        return undefined;
    }
    return hit.value;
}

function cacheSet(token, value) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
        // Cheap eviction: drop the oldest insertion. Map preserves insert order.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(token, {
        value,
        expires: Date.now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
}

/**
 * Drop a token from the cache. Call after an explicit revocation so a revoked
 * credential stops working immediately rather than at the end of its TTL.
 * @param {string} token
 */
export function invalidateToken(token) {
    cache.delete(token);
}

/**
 * Validate a credential.
 *
 * Fails closed: if the validator cannot be reached we reject rather than
 * guess. Because auth is only checked at connection setup, and successes are
 * cached, a brief php-fpm hiccup does not disturb established sessions.
 *
 * @param {string|null} token
 * @returns {Promise<{username: string, kind?: string, isAdmin?: boolean, invitedApps?: string[]}|null>}
 */
export async function validateToken(token) {
    if (!token || typeof token !== 'string') {
        return ALLOW_ANONYMOUS ? { username: 'anonymous' } : null;
    }

    // Shape check before spending a round trip. Session and device tokens are
    // 64 hex chars; so are API keys, which are generated the same way.
    if (!/^[a-f0-9]{64}$/i.test(token)) {
        return ALLOW_ANONYMOUS ? { username: 'anonymous' } : null;
    }

    const cached = cacheGet(token);
    if (cached !== undefined) {
        return cached ?? (ALLOW_ANONYMOUS ? { username: 'anonymous' } : null);
    }

    let result = null;
    try {
        const res = await fetch(VALIDATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
            signal: AbortSignal.timeout(5000),
        });

        if (res.ok) {
            const body = await res.json();
            if (body?.valid && body.username) {
                result = {
                    username: body.username,
                    kind: body.kind,
                    isAdmin: !!body.is_admin,
                    invitedApps: body.invited_apps ?? [],
                };
            }
        } else if (res.status !== 401) {
            // 401 is a normal "bad token". Anything else is a real fault, and
            // caching it as a miss would extend the outage past its cause.
            console.error(`[auth] validator returned HTTP ${res.status}`);
            return null;
        }
    } catch (err) {
        console.error('[auth] validator unreachable:', err.message);
        return null;
    }

    cacheSet(token, result);
    return result ?? (ALLOW_ANONYMOUS ? { username: 'anonymous' } : null);
}
