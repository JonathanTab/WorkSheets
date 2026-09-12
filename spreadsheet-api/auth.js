/**
 * auth.js — which credential a request to the spreadsheet API is presenting.
 *
 * This service does not decide whether a credential is good. It forwards one to
 * Scriptorium, which is the single place that answers that question, so there is
 * deliberately no validate.php call here — a second opinion that can drift is
 * exactly what the consolidation was meant to remove (AUTH.md §11).
 *
 * What it does decide is *which* credential the caller offered, and that used
 * to be hand-rolled in server.js as "Authorization, else the first of
 * session_token / device_token in the Cookie header". "First in the header" is
 * not the rule: lib/iauth.php resolves device_token ahead of session_token
 * domain-wide, so a browser carrying both had this service forward the session
 * token where every other component on the domain would have used the device
 * one — two different identities whenever the tab was signed in as someone the
 * device is not. colloquium and yjs-server had the same bug; all three now come
 * from one place.
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

const { extractCredential } = await import(AUTH_LIB);

/**
 * Resolve a credential from the request: an Authorization header, or a
 * session_token/device_token cookie.
 *
 * The cookie channel exists for browser callers of /api/sheets/* (the ledger
 * PWAs) that authenticate to the rest of the site via the session cookie and
 * hold no API key. It needs no other change anywhere in this file: a session or
 * device token is just as valid a Bearer credential downstream as an API key —
 * PHP's itoken_resolve() and yjs-server's validator treat all three kinds
 * identically — so the cookie's value is used exactly like an apiKey from here
 * on.
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
 * @returns {string|null}
 */
export function extractToken(req) {
    return extractCredential(req, null, { order: ['bearer', 'cookie'] })?.token ?? null;
}
