// The whole sign-in surface: password, Google, and the code fallback.
import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import handler from '../api/portal-lookup.js';
import googleStart from '../api/google-auth-url.js';
import { hashPassword } from '../api/_lib/password.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

process.env.RESEND_API_KEY = 'test';
process.env.GOOGLE_CLIENT_ID = 'cid'; process.env.GOOGLE_REDIRECT_URI = 'https://x/api/google-callback';
let sent = [], store = new Map(), appData;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('resend.com')) {
    const b = JSON.parse(opts?.body || '{}');
    sent.push({ to: b.to?.[0], subject: b.subject, html: b.html });
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};
kv.get = async k => (k === 'app-data' ? appData : (store.get(k) ?? null));
kv.set = async (k, v) => { if (k === 'app-data') appData = v; else store.set(k, v); return 'OK'; };
kv.del = async k => { store.delete(k); return 1; };
kv.incr = async k => { const v = (Number(store.get(k)) || 0) + 1; store.set(k, v); return v; };
kv.expire = async () => 1;

const PW = 'rivkas good password';
let hashed;
async function reset() {
  sent = []; store = new Map();
  hashed = hashed || await hashPassword(PW);
  appData = { clients: [
      { id:'c1', name:'Rivka Stern', email:'rivka@example.com', phone:'3475550101', passwordHash: hashed },
      { id:'c2', name:'No Password', email:'nopw@example.com' },
      { id:'c3', name:'Blocked', email:'blocked@example.com', passwordHash: hashed, blocked:true }
    ], bookings: [], settings: {} };
}
function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.writeHead = (c, h) => { r.statusCode = c; r.headers = h; return r; };
  r.end = () => r;
  r.send = b => { r.body = b; return r; };
  return r;
}
const post = async body => { const res = mockRes(); await handler({ method:'POST', query:{}, headers:{}, body }, res); return res; };

// --- password sign-in ---------------------------------------------------------------------
await reset();
let res = await post({ action:'password-login', email:'rivka@example.com', password: PW });
check('the right password signs them in', !!res.body?.token, JSON.stringify(res.body).slice(0,140));
check('...and returns their sessions', res.body?.name === 'Rivka Stern');

res = await post({ action:'password-login', email:'rivka@example.com', password:'wrong one' });
check('a wrong password is refused', !res.body?.token && res.statusCode === 401);
check('...without saying which part was wrong', /email and password/i.test(res.body?.error || ''), res.body?.error);

res = await post({ action:'password-login', email:'RIVKA@Example.com ', password: PW });
check('the email is matched regardless of case or spacing', !!res.body?.token);

res = await post({ action:'password-login', email:'nopw@example.com', password:'anything' });
check('a client who has never set one cannot sign in this way', !res.body?.token);
res = await post({ action:'password-login', email:'blocked@example.com', password: PW });
check('a blocked client cannot sign in', !res.body?.token);
res = await post({ action:'password-login', email:'nobody@example.com', password: PW });
check('an unknown address cannot sign in', !res.body?.token);
check('...and gets the same message as a wrong password',
      res.body?.error === (await post({ action:'password-login', email:'rivka@example.com', password:'nope' })).body?.error);

// guessing is capped
await reset();
for (let i = 0; i < 8; i++) await post({ action:'password-login', email:'rivka@example.com', password:'nope' });
res = await post({ action:'password-login', email:'rivka@example.com', password: PW });
check('guessing is cut off, even with the right password', res.statusCode === 429 && !res.body?.token);

// --- setting a password -------------------------------------------------------------------------
await reset();
res = await post({ action:'request-password-setup', email:'rivka@example.com' });
check('asking for a set-password link succeeds', res.statusCode === 200);
check('an email goes out', sent.length === 1 && sent[0].to === 'rivka@example.com');
const link = (sent[0].html.match(/\?setpassword=([A-Za-z0-9_-]+)/) || [])[1];
check('the email carries a one-time link', !!link && link.length > 20);

const unknown = await post({ action:'request-password-setup', email:'stranger@example.com' });
check('an unknown address gets the same answer', JSON.stringify(unknown.body) === JSON.stringify(res.body));
check('...and is sent nothing', !sent.some(s => s.to === 'stranger@example.com'));

let chk = mockRes();
await handler({ method:'GET', query:{ action:'check-setup-token', token:link }, headers:{}, body:null }, chk);
check('the link checks out before the form is shown', chk.body?.valid === true && chk.body?.name === 'Rivka Stern');

res = await post({ action:'set-password', token: link, password:'short' });
check('a too-short password is refused', res.statusCode === 400 && /at least 8/.test(res.body?.error || ''));
res = await post({ action:'set-password', token: link, password:'brand new password' });
check('a good password is saved and signs them straight in', !!res.body?.token, JSON.stringify(res.body).slice(0,120));
check('...and is stored hashed, not as typed',
      appData.clients[0].passwordHash.startsWith('scrypt$') && !appData.clients[0].passwordHash.includes('brand new password'));
check('the new password works', !!(await post({ action:'password-login', email:'rivka@example.com', password:'brand new password' })).body?.token);
check('the old one no longer does', !(await post({ action:'password-login', email:'rivka@example.com', password: PW })).body?.token);
check('the link cannot be used twice',
      (await post({ action:'set-password', token: link, password:'another password' })).statusCode === 400);
res = await post({ action:'set-password', token:'made-up-token', password:'another password' });
check('a made-up link is refused', res.statusCode === 400);

// --- the code fallback still works ------------------------------------------------------------------
await reset();
await post({ action:'request-code', email:'rivka@example.com' });
const code = store.get('portal-code:rivka@example.com')?.code;
check('the one-time code still works alongside passwords',
      !!(await post({ action:'verify-code', email:'rivka@example.com', code })).body?.token);

// --- Google: the two journeys must not be confused ------------------------------------------------------
let g = mockRes();
await googleStart({ query:{ purpose:'client-signin' }, headers:{} }, g);
const loc = g.headers?.Location || '';
check('a client sign-in needs no admin token', g.statusCode === 302, String(g.statusCode));
check('...and asks only for identity', /scope=openid(\+|%20)email(\+|%20)profile/.test(loc), loc.slice(0, 200));
check('...never for the calendar', !/auth%2Fcalendar/.test(loc));
check('...and never for offline access, which is what mints a refresh token', !/access_type=offline/.test(loc));
const stateKey = [...store.keys()].find(k => k.startsWith('oauth-state:'));
check('the state records which journey it is', store.get(stateKey)?.purpose === 'client-signin');

g = mockRes();
await googleStart({ query:{}, headers:{} }, g);
check('connecting the calendar still requires an admin session', g.statusCode === 401, String(g.statusCode));

// --- the page --------------------------------------------------------------------------------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('the sign-in form asks for a password', /id="portal-password"/.test(html));
check('...offers Google', /portal-google-btn/.test(html) && /purpose=client-signin/.test(html));
check('...offers setting or resetting one', /portal-setpass-link/.test(html));
check('...keeps the code as a fallback', /portal-use-code/.test(html));
check('a set-password link opens the form', /openPasswordSetupFromLink/.test(html));
check('coming back from Google is handled', /openPortalFromGoogle/.test(html));
check('...with the session token taken from the fragment, not the query string',
      /portal-token=\(\[\^&\]\+\)/.test(html));
check('...and cleared from the address bar', /history\.replaceState\(null, '', window\.location\.pathname \+ '#portal'\)/.test(html));
check('a Google account with no matching client is explained', /isn.t on file/.test(html));

// --- the Google configuration check ----------------------------------------------------------
// It asks Google from the server, where Google is reachable, and reports what comes back.
const adminMod = await import('../api/admin-data.js');
const adminHandler = adminMod.default;
process.env.GOOGLE_CLIENT_ID = 'cid'; process.env.GOOGLE_REDIRECT_URI = 'https://x/api/google-callback';
store.set('admin-session:tok', true);
appData = appData || { clients: [], bookings: [], settings: {} };

async function probeWith(reply) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('accounts.google.com')) return reply;
    return realFetch(url);
  };
  const r = mockRes();
  await adminHandler({ method:'GET', query:{ action:'test-google-signin' }, headers:{ 'x-admin-token':'tok' }, body:null }, r);
  globalThis.fetch = realFetch;
  return r.body;
}
const page = (body, status = 200, location = null) => ({
  status, text: async () => body, headers: { get: () => location }
});

let out = await probeWith(page('<html>Choose an account</html>', 200));
check('a working setup reports ok', out?.ok === true, JSON.stringify(out));
check('...and says what would happen next', /choose an account/i.test(out?.message || ''));

out = await probeWith(page('Error 400: redirect_uri_mismatch', 400));
check('an unregistered redirect address is identified', out?.ok === false && out?.problem === 'redirect-mismatch', JSON.stringify(out));
check('...and names the address Google rejected', out?.redirectUri === 'https://x/api/google-callback');

out = await probeWith(page('Error 401: invalid_client', 401));
check('a wrong client id is identified', out?.problem === 'bad-client', JSON.stringify(out));

out = await probeWith(page('Error 400: invalid_scope', 400));
check('refused permissions are identified', out?.problem === 'bad-scope', JSON.stringify(out));

out = await probeWith(page('', 302, 'https://accounts.google.com/signin/v2/identifier'));
check('a redirect into Google sign-in counts as working', out?.ok === true, JSON.stringify(out));

out = await probeWith(page('', 302, 'https://evil.example.com/'));
check('a redirect somewhere else does not count as working', out?.ok === false, JSON.stringify(out));

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { if (String(url).includes('accounts.google.com')) throw new Error('network down'); return realFetch(url); };
  const r = mockRes();
  await adminHandler({ method:'GET', query:{ action:'test-google-signin' }, headers:{ 'x-admin-token':'tok' }, body:null }, r);
  globalThis.fetch = realFetch;
  check('a network failure is reported, not thrown', r.body?.problem === 'unreachable', JSON.stringify(r.body));
}

{
  const saved = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  const r = mockRes();
  await adminHandler({ method:'GET', query:{ action:'test-google-signin' }, headers:{ 'x-admin-token':'tok' }, body:null }, r);
  process.env.GOOGLE_CLIENT_ID = saved;
  check('missing configuration is reported plainly', r.body?.problem === 'missing-config', JSON.stringify(r.body));
}

const r401 = mockRes();
await adminHandler({ method:'GET', query:{ action:'test-google-signin' }, headers:{}, body:null }, r401);
check('the check needs an admin session', r401.statusCode === 401);

check('Manage warns that Testing mode cannot be detected this way', /Testing mode/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
