// Pins which credentials spreadsheet-api forwards to Scriptorium, and in what
// order.
//
// This service never decides whether a credential is *good* — Scriptorium
// answers that, and there is deliberately no validate.php call here. What it
// does decide is which of several offered credentials to try, and that is where
// it used to be wrong twice over: the hand-rolled version took whichever of
// session_token / device_token appeared first in the Cookie header, and it kept
// only that one, so a rejected credential ended the request. lib/iauth.php
// ranks the two cookies and *skips* whichever turns out to be dead, so a
// browser carrying both was read differently here than everywhere else on the
// domain — and a stale cookie beside a live session failed the request outright.
//
// Run: node test/auth-extraction.mjs
//
// INSTRUMENTA_AUTH_LIB must be set before ./auth.js is imported, because it
// resolves the shared library at module scope (that ordering is the reason
// ./env.js exists). Setting it here rather than relying on spreadsheet-api/.env
// keeps the test pointed at the working tree.

const SESSION = 'a'.repeat(64);
const DEVICE  = 'b'.repeat(64);

process.env.INSTRUMENTA_AUTH_LIB =
    new URL('../../../instrumenta-auth/src/server/index.js', import.meta.url).href;

const { extractToken, extractTokens, firstAccepted, AUTH_EXPIRED } = await import('../auth.js');

const req = ({ authorization, cookie } = {}) => ({
    headers: { ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) },
});

let fail = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) fail++;
    const show = (v) => (v === null ? 'null' : JSON.stringify(v));
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  -> ${show(actual)}${ok ? '' : ` (expected ${show(expected)})`}`);
};

/** check(), for the ordered candidate list. */
const checkList = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  -> ${a}${ok ? '' : ` (expected ${e})`}`);
};

// --- the credential a caller offers ---------------------------------------

check('bearer', extractToken(req({ authorization: `Bearer ${DEVICE}` })), DEVICE);
check('bearer is case-insensitive', extractToken(req({ authorization: `bearer ${DEVICE}` })), DEVICE);
check('session cookie alone', extractToken(req({ cookie: `session_token=${SESSION}` })), SESSION);
check('device cookie alone', extractToken(req({ cookie: `device_token=${DEVICE}` })), DEVICE);

// The first regression. session_token precedes device_token in the header here,
// and the old regex took whichever came first — so the answer depended on
// header order, which is not a rule anything downstream can rely on.
check(
    'session cookie outranks device cookie',
    extractToken(req({ cookie: `device_token=${DEVICE}; session_token=${SESSION}` })),
    SESSION,
);
check(
    'and does so whatever the header order',
    extractToken(req({ cookie: `session_token=${SESSION}; device_token=${DEVICE}` })),
    SESSION,
);

check(
    'bearer outranks both cookies',
    extractToken(req({ authorization: `Bearer ${SESSION}`, cookie: `device_token=${DEVICE}` })),
    SESSION,
);

// --- the fallback ----------------------------------------------------------
//
// Precedence decides what is *preferred*; this decides what happens when the
// preferred one is rejected. route() walks these on AUTH_EXPIRED, so a dead
// device cookie beside a live session no longer fails the request — which is
// the second regression, and the one that actually took the ledger down.

checkList(
    'both cookies are offered, in precedence order',
    extractTokens(req({ cookie: `device_token=${DEVICE}; session_token=${SESSION}` })),
    [SESSION, DEVICE],
);
checkList(
    'a bearer is offered ahead of the cookies',
    extractTokens(req({ authorization: `Bearer ${DEVICE}`, cookie: `session_token=${SESSION}` })),
    [DEVICE, SESSION],
);
checkList(
    'the same token offered twice is offered once',
    extractTokens(req({ authorization: `Bearer ${SESSION}`, cookie: `session_token=${SESSION}` })),
    [SESSION],
);
checkList(
    'a rejected cookie is still offered as a fallback',
    extractTokens(req({ cookie: `session_token=${SESSION}; device_token=${DEVICE}` })),
    [SESSION, DEVICE],
);
checkList('nothing offered means nothing to try', extractTokens(req()), []);

// --- things that are not credentials --------------------------------------

check('nothing offered', extractToken(req()), null);
check('unrelated cookie', extractToken(req({ cookie: 'theme=dark' })), null);
check('empty cookie value', extractToken(req({ cookie: 'device_token=' })), null);

// Well-formedness. All three credential kinds are 64 hex (AUTH.md §2), and the
// shared extractor enforces that on every channel. The old code checked the
// cookie channel but not the bearer one, so garbage travelled upstream and came
// back as a confusing auth error from Scriptorium instead of a plain 401 here.
check('malformed bearer', extractToken(req({ authorization: 'Bearer nope' })), null);
// 63 characters is one short of a credential; forwarding it would only buy a
// confusing upstream error.
check('short bearer', extractToken(req({ authorization: `Bearer ${'a'.repeat(63)}` })), null);
check('malformed cookie', extractToken(req({ cookie: 'device_token=nope' })), null);
check('bearer with no value', extractToken(req({ authorization: 'Bearer' })), null);
check('a different scheme', extractToken(req({ authorization: `Basic ${DEVICE}` })), null);

// Deliberate: a REST caller can set a header, so the query channel that the
// WebSocket services need would only buy a credential in the access log.
check(
    'query param is not a channel',
    extractToken({ headers: {}, url: `/x?token=${DEVICE}` }),
    null,
);

// --- the walk --------------------------------------------------------------
//
// Extraction decides the order; this decides what happens when the preferred
// credential is rejected. Only AUTH_EXPIRED moves the walk on — it is the one
// failure that means "this credential is bad". Anything else is a fault the
// next credential would meet too, and retrying would dress an outage up as a
// rejection.

/** An `attempt` that accepts the named tokens and rejects everything else. */
const accepting = (...good) => async (token) => {
    if (good.includes(token)) return `client:${token}`;
    throw new Error(AUTH_EXPIRED);
};
/** An `attempt` that fails for reasons that are not about the credential. */
const failing = (message) => async () => { throw new Error(message); };

const walked = await firstAccepted([SESSION, DEVICE], accepting(DEVICE));
check('a rejected credential falls through to the next', walked.value, `client:${DEVICE}`);
check('and reports which one worked', walked.credential, DEVICE);
check('and how many it took', walked.tried, 2);

const preferred = await firstAccepted([SESSION, DEVICE], accepting(SESSION));
check('the preferred credential is used when it is good', preferred.value, `client:${SESSION}`);
check('with no second attempt', preferred.tried, 1);

const all = await firstAccepted([SESSION, DEVICE], accepting());
check('all rejected is no credential', all.credential, null);
check('covering every candidate', all.tried, 2);
check('and the rejection is what gets reported', all.error?.message, AUTH_EXPIRED);

const fault = await firstAccepted([SESSION, DEVICE], failing('HTTP_500'));
check('a fault stops the walk', fault.tried, 1);
check('and is not reported as a rejection', fault.error?.message, 'HTTP_500');

const none = await firstAccepted([], accepting(SESSION));
check('nothing offered means nothing tried', none.tried, 0);
check('and no error to report', none.error, null);

// The end-to-end shape of the ledger failure: a dead session cookie sitting
// beside a good device cookie. Extraction offers both, the walk rejects the
// first and accepts the second, and the request goes through.
const ledger = req({ cookie: `session_token=${SESSION}; device_token=${DEVICE}` });
const recovered = await firstAccepted(extractTokens(ledger), accepting(DEVICE));
check('a dead session no longer fails a request with a live device', recovered.value, `client:${DEVICE}`);
check('and it was the device that carried it', recovered.credential, DEVICE);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;
