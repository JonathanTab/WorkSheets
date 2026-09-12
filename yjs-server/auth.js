/**
 * auth.js — credentials and link-sharing access for the Yjs server.
 *
 * This file has been through two rounds of de-duplication. It started as a
 * private re-implementation that read token files straight out of the
 * session-token directory and checked `expires` itself, which disagreed with
 * PHP: the PHP side rotates tokens and marks the predecessor `superseded_by`,
 * a concept this file knew nothing about, so a token PHP considered valid was
 * rejected here.
 *
 * It then asked api/validate.php over the loopback vhost instead — one
 * implementation of "is this credential good" — but still carried its own
 * credential extraction, its own outcome cache, and its own copy of the
 * link-sharing check. The extraction had the same precedence bug colloquium's
 * did: it took whichever of session_token/device_token appeared first in the
 * Cookie header, while iauth.php resolves device_token ahead of session_token,
 * so PHP and the realtime layer could disagree about which credential a
 * connection was even using.
 *
 * All of that now comes from the shared library the site serves (AUTH.md 11).
 * This service runs on the same box as the site, so the "dependency" is a path
 * rather than an install, and there is no way for it to pin credential rules
 * that the browser half has already moved past.
 */

const AUTH_LIB = process.env.INSTRUMENTA_AUTH_LIB
    || '/var/www/instrumenta/.assets/auth/src/server/index.js';

const {
    createValidator, createPublicAccessChecker, matchesRoom, statusFor,
} = await import(AUTH_LIB);

const VALIDATE_URL = process.env.VALIDATE_URL || 'http://127.0.0.1/api/validate.php';
const STORAGE_API_URL = process.env.STORAGE_API_URL || 'http://127.0.0.1/api/storage.php';

/**
 * Fail closed when the validator cannot be reached.
 *
 * `validateToken()` below collapses an unreachable validator to "no identity",
 * which is what this service has always done and is defensible here: auth is
 * only checked at connection setup and successes are cached for a minute, so a
 * brief php-fpm hiccup does not disturb established sessions.
 *
 * Callers that can tell the difference should use validateRequest() instead,
 * which returns the outcome and lets statusFor() answer 503 — "ask again" —
 * rather than 401, "your credential is bad". The two are not the same thing,
 * and a client that reads the second as the first throws away a good token.
 */
const validator = createValidator({
    validateUrl: VALIDATE_URL,
    onUnknown: 'propagate',
    // Same shape as the hand-rolled cache this replaces, including the bound.
    cache: { positiveTtlMs: 60_000, negativeTtlMs: 10_000, max: 5000 },
    logger: console,
});

/** Link-shared documents, cached briefly so a reconnect storm is not a PHP storm. */
const publicAccess = createPublicAccessChecker({
    storageUrl: STORAGE_API_URL,
    logger: console,
});

export { statusFor, matchesRoom };

/**
 * Validate a credential and return the identity, or null.
 *
 * Kept as the fail-closed convenience form. Anything that needs to distinguish
 * "this credential is bad" from "I could not check" should call
 * validateRequest() and map the outcome with statusFor().
 *
 * @param {string|null} token
 * @returns {Promise<{username: string, kind?: string, isAdmin?: boolean, invitedApps?: string[]}|null>}
 */
export async function validateToken(token) {
    const outcome = await validator.validate(token);
    return outcome.state === 'user' ? outcome : null;
}

/**
 * Extract this request's credential (bearer, query, or cookie) and validate it.
 *
 * @returns {Promise<{outcome: object, source: string|null, token: string|null}>}
 */
export function validateRequest(req, url) {
    return validator.validateRequest(req, url);
}

/**
 * @param {string} fileId
 * @returns {Promise<{roomId: string, publicWrite: boolean}|null>}
 *   null when the file doesn't exist, isn't public, or the check failed
 *   (fails closed — a lookup error must not grant access).
 */
export const checkPublicFileAccess = publicAccess.check;
