/**
 * auth.js — which credential a request to the spreadsheet API is presenting.
 *
 * This service does not decide whether a credential is good. It forwards one to
 * Scriptorium, which is the single place that answers that question, so there is
 * deliberately no validate.php call here — a second opinion that can drift is
 * exactly what the consolidation was meant to remove (AUTH.md §11).
 *
 * What it does decide is *which* credentials the caller offered, and in what
 * order to try them. That used to be hand-rolled in server.js as
 * "Authorization, else the first of session_token / device_token in the Cookie
 * header". "First in the header" is not the rule: lib/iauth.php tries the two
 * cookies in a fixed order and skips either one that turns out to be dead
 * (§3), so a browser carrying both was read differently here than everywhere
 * else on the domain. colloquium and yjs-server had the same bug; all three now
 * come from one place.
 *
 * It lives in its own module rather than in server.js so the extraction can be
 * exercised without standing up the HTTP server and its upstream connections.
 * Its dependency on ./env.js is what makes INSTRUMENTA_AUTH_LIB settable from
 * spreadsheet-api/.env: that has to load before the path is read, and importing
 * env.js here means every consumer gets that ordering for free instead of each
 * one having to remember to import it first.
 */

import './env.js';

const AUTH_LIB = process.env.INSTRUMENTA_AUTH_LIB
    || '/var/www/instrumenta/.assets/auth/src/server/index.js';

const { extractCredentials } = await import(AUTH_LIB);

/**
 * Every credential the request offers, highest precedence first.
 *
 * Plural because a request can offer two: a browser signed in to the site sends
 * its session_token cookie *and*, if it holds one, its device_token cookie. Only
 * Scriptorium can say whether either is good, so this service must not pick one
 * and forward its rejection as the request's verdict. Try them in order —
 * server.js does, on AUTH_EXPIRED.
 *
 * The cookie channel exists for browser callers of /api/sheets/* (the ledger
 * PWAs) that authenticate to the rest of the site via a cookie and hold no API
 * key. It needs no other change anywhere in this file: a session or device
 * token is just as valid a Bearer credential downstream as an API key — PHP's
 * itoken_resolve() and yjs-server's validator treat all three kinds identically
 * — so a cookie's value is used exactly like an apiKey from here on.
 *
 * Query params are deliberately NOT a channel. The only thing that forces one
 * is a browser WebSocket handshake, which cannot set headers; a REST caller
 * can, and accepting `?token=` here would write a live credential into access
 * logs, history and Referer for no gain.
 *
 * Well-formedness: the shared extractor requires 64 hex characters, which all
 * three credential kinds are (AUTH.md §2). The hand-rolled version checked the
 * cookie channel but not the bearer one, so `Authorization: Bearer garbage`
 * used to reach Scriptorium and come back as a confusing upstream auth error;
 * now it is a plain 401 without the round trip.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string[]} possibly empty, never null
 */
export function extractTokens(req) {
    return extractCredentials(req, null, { order: ['bearer', 'cookie'] }).map((c) => c.token);
}

/**
 * The single highest-precedence credential, or null.
 *
 * Kept for callers that genuinely have only one credential in play. Anything
 * serving a browser should use extractTokens() instead: taking the first of
 * several is the bug the plural form exists to retire.
 *
 * @returns {string|null}
 */
export function extractToken(req) {
    return extractTokens(req)[0] ?? null;
}

/**
 * The error Scriptorium raises when it is sure a credential is bad.
 *
 * StorageAPI surfaces its upstream 401 as this bare string — there is no error
 * class to catch — and it is the only failure that should move the walk along
 * to the next credential.
 */
const AUTH_EXPIRED = 'AUTH_EXPIRED';

/**
 * Try each offered credential in turn, stopping at the first that is accepted.
 *
 * `attempt` should throw AUTH_EXPIRED for a credential Scriptorium rejected and
 * return what you wanted on success — for route() that is a connected
 * SpreadsheetClient.
 *
 * Only AUTH_EXPIRED advances the walk. Any other failure is a fault, and the
 * next credential would meet it too: retrying would turn one upstream 500 into
 * two and then report the result as though the credential had been rejected.
 * That distinction is the rule the rest of this system runs on (AUTH.md §6) —
 * "this is bad" and "I could not check" are not the same answer.
 *
 * Lives here rather than inline in route() so it can be exercised without
 * standing up the HTTP server and its upstream connections.
 *
 * @template T
 * @param {string[]} credentials  Highest precedence first.
 * @param {(credential: string) => Promise<T>} attempt
 * @returns {Promise<{credential: string|null, value: T|null, error: Error|null, tried: number}>}
 *   `credential`/`value` are the one that worked, or nulls with `error` set to
 *   whatever came back last. `tried` is how many were consulted.
 */
export async function firstAccepted(credentials, attempt) {
    let tried = 0;
    let lastError = null;
    for (const credential of credentials) {
        tried++;
        try {
            return { credential, value: await attempt(credential), error: null, tried };
        } catch (err) {
            lastError = err;
            if (err.message !== AUTH_EXPIRED) break;
        }
    }
    return { credential: null, value: null, error: lastError, tried };
}

export { AUTH_EXPIRED };
