// Pins the auth decision the Yjs server makes at connection setup: which
// credential a request is using, whether it is good, and whether an anonymous
// visitor may still be admitted to a link-shared document.
//
// The extraction used to be hand-rolled here, and its cookie regex took
// whichever of session_token/device_token appeared first in the header — so the
// answer depended on header order, which is not a rule. It then kept only that
// one, where iauth.php ranks the two and skips whichever turns out to be dead.
// PHP and the realtime layer could therefore disagree about which credential a
// connection was even using, and a stale cookie beside a live one failed the
// connection outright. Those are the regressions this covers.
//
// Run: node test/auth-outcomes.mjs
import http from 'node:http';

// Each token gets its own answer, so the positive cache cannot let one case
// stand in for another.
const SESSION = 'a'.repeat(64);
const DEVICE  = 'b'.repeat(64);
const GOOD    = 'c'.repeat(64);
const OUTAGE  = '1'.repeat(64);
const DEAD    = 'f'.repeat(64);  // no ANSWERS entry, so {valid:false}

const ANSWERS = {
  [SESSION]: { valid: true, username: 'cookie-session-user', kind: 'session' },
  [DEVICE]:  { valid: true, username: 'cookie-device-user',  kind: 'device' },
  [GOOD]:    { valid: true, username: 'jon', kind: 'device' },
};

const validateStub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const token = JSON.parse(body || '{}').token;
    res.setHeader('Content-Type', 'application/json');
    if (token === OUTAGE) return res.writeHead(500).end('{}');
    res.writeHead(200).end(JSON.stringify(ANSWERS[token] || { valid: false }));
  });
});

const FILE_ID = 'file-abc';
const storageStub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  const id = url.searchParams.get('id');
  if (id === FILE_ID) return res.end(JSON.stringify({ publicRead: true, publicWrite: false, roomId: 'room-1' }));
  if (id === 'writable') return res.end(JSON.stringify({ publicRead: true, publicWrite: true, roomId: 'room-2' }));
  res.writeHead(404).end('{}');
});

await new Promise((r) => validateStub.listen(0, '127.0.0.1', r));
await new Promise((r) => storageStub.listen(0, '127.0.0.1', r));

process.env.VALIDATE_URL = `http://127.0.0.1:${validateStub.address().port}/api/validate.php`;
process.env.STORAGE_API_URL = `http://127.0.0.1:${storageStub.address().port}/api/storage.php`;
// An href, because dynamic import() needs file:// on Windows. The server passes
// a plain POSIX path, which import() accepts there.
process.env.INSTRUMENTA_AUTH_LIB =
  new URL('../../../instrumenta-auth/src/server/index.js', import.meta.url).href;

const { validateRequest, statusFor, matchesRoom, checkPublicFileAccess } =
  await import('../auth.js');

const req = ({ authorization, cookie } = {}) => ({
  headers: { ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) },
});
const decide = async (r, url = null) => statusFor((await validateRequest(r, url)).outcome);

let fail = 0;
const show = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));
/** Structural, so the object-returning checks compare by value. */
const check = (name, actual, expected) => {
  const ok = show(actual) === show(expected);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  -> ${show(actual)}${ok ? '' : ` (expected ${show(expected)})`}`);
};

check('no credential at all', await decide(req()), 401);
check('valid bearer', await decide(req({ authorization: `Bearer ${GOOD}` })), 200);
check('dead token', await decide(req({ authorization: `Bearer ${DEAD}` })), 401);
check('malformed token', await decide(req({ authorization: 'Bearer nope' })), 401);

// The regression: session_token precedes device_token in the header, and the
// old regex took whichever came first — so the answer depended on header order.
// iauth.php ranks session ahead of device, so this server must too.
check(
  'cookie precedence: session wins over device',
  await decide(req({ cookie: `session_token=${SESSION}; device_token=${DEVICE}` })),
  200,
);
check(
  'cookie precedence: session is the one validated',
  (await validateRequest(req({ cookie: `session_token=${SESSION}; device_token=${DEVICE}` }), null))
    .outcome.username,
  'cookie-session-user',
);
// The other half: a dead session must not fail the connection while a live
// device token is sitting right there. Ranking session first is only safe
// because both are tried.
check(
  'cookie fallback: a dead session falls through to the device',
  (await validateRequest(req({ cookie: `session_token=${DEAD}; device_token=${DEVICE}` }), null))
    .outcome.username,
  'cookie-device-user',
);
check(
  'cookie fallback: a dead device does not reject a live session',
  (await validateRequest(req({ cookie: `device_token=${DEAD}; session_token=${SESSION}` }), null))
    .outcome.username,
  'cookie-session-user',
);
check(
  'session cookie alone still works',
  (await validateRequest(req({ cookie: `session_token=${SESSION}` }), null)).outcome.username,
  'cookie-session-user',
);
check(
  'device cookie alone still works',
  (await validateRequest(req({ cookie: `device_token=${DEVICE}` }), null)).outcome.username,
  'cookie-device-user',
);

// ?auth= is what native clients use; ?token= is what the colloquium WS uses.
check('query param', await decide(req(), new URL(`http://x/ws?auth=${GOOD}`)), 200);

check('validator 500 is 503, not 401',
  await decide(req({ authorization: `Bearer ${OUTAGE}` })), 503);

// --- link sharing ---------------------------------------------------------

check('a public file grants its own room', matchesRoom(await checkPublicFileAccess(FILE_ID), 'room-1'),
  { readOnly: true });
check('the same share cannot walk into another room',
  matchesRoom(await checkPublicFileAccess(FILE_ID), 'room-2'), null);
check('a writable share grants read-write',
  matchesRoom(await checkPublicFileAccess('writable'), 'room-2'), { readOnly: false });
check('an unknown file grants nothing', await checkPublicFileAccess('nope'), null);

// Wait for the stubs to actually close rather than calling process.exit() with
// requests still in flight: exiting mid-teardown aborts on Windows (libuv's
// UV_HANDLE_CLOSING assertion), which reports a failure for a run that passed.
await new Promise((r) => validateStub.close(r));
await new Promise((r) => storageStub.close(r));
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;
