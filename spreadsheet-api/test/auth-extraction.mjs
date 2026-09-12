// Pins which credential spreadsheet-api forwards to Scriptorium.
//
// This service never decides whether a credential is *good* — Scriptorium
// answers that, and there is deliberately no validate.php call here. What it
// does decide is which of several offered credentials to forward, and that is
// where it used to be wrong: the hand-rolled version took whichever of
// session_token / device_token appeared first in the Cookie header, while
// lib/iauth.php resolves device_token ahead of session_token domain-wide. A
// browser carrying both was therefore read as the session identity here and the
// device identity everywhere else.
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

const { extractToken } = await import('../auth.js');

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

// --- the credential a caller offers ---------------------------------------

check('bearer', extractToken(req({ authorization: `Bearer ${DEVICE}` })), DEVICE);
check('bearer is case-insensitive', extractToken(req({ authorization: `bearer ${DEVICE}` })), DEVICE);
check('session cookie alone', extractToken(req({ cookie: `session_token=${SESSION}` })), SESSION);
check('device cookie alone', extractToken(req({ cookie: `device_token=${DEVICE}` })), DEVICE);

// The regression. session_token precedes device_token in the header, and the
// old regex took whichever came first — i.e. the session token here.
check(
    'device cookie outranks session cookie',
    extractToken(req({ cookie: `session_token=${SESSION}; device_token=${DEVICE}` })),
    DEVICE,
);
check(
    'and outranks it the other way round too',
    extractToken(req({ cookie: `device_token=${DEVICE}; session_token=${SESSION}` })),
    DEVICE,
);

check(
    'bearer outranks both cookies',
    extractToken(req({ authorization: `Bearer ${SESSION}`, cookie: `device_token=${DEVICE}` })),
    SESSION,
);

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

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;
