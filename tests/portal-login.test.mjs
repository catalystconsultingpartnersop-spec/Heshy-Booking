// Signing in to the client portal. It used to be email + phone number — both findable, so
// anyone holding them could read a client's history and cancel their sessions.
import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import handler from '../api/portal-lookup.js';
import { portalCodeEmail } from '../api/_lib/email.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

process.env.RESEND_API_KEY = 'test';
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

function reset() {
  sent = []; store = new Map();
  appData = {
    clients: [
      { id: 'c1', name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101' },
      { id: 'c2', name: 'Blocked Person', email: 'blocked@example.com', phone: '3475550202', blocked: true }
    ],
    bookings: [], settings: { clientCancelCutoffHours: 3 }
  };
}
function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}
const post = async body => { const res = mockRes(); await handler({ method:'POST', query:{}, headers:{}, body }, res); return res; };
const codeFor = email => store.get('portal-code:' + email)?.code;

// --- the old way is gone ------------------------------------------------------------------------
reset();
let res = await post({ action:'login', email:'rivka@example.com', phone:'3475550101' });
check('email + phone no longer signs anyone in', !res.body?.token, JSON.stringify(res.body).slice(0,120));

// --- asking for a code --------------------------------------------------------------------------
reset();
res = await post({ action:'request-code', email:'rivka@example.com' });
check('asking for a code succeeds', res.statusCode === 200);
check('an email goes out', sent.length === 1 && sent[0].to === 'rivka@example.com');
check('...with the code in the subject so it is visible in a notification', /\d{6}/.test(sent[0].subject || ''), sent[0]?.subject);
check('a six digit code is stored', /^\d{6}$/.test(codeFor('rivka@example.com') || ''), codeFor('rivka@example.com'));
check('no session is issued yet', !res.body?.token);

// --- an unknown address gives nothing away --------------------------------------------------------
reset();
const unknown = await post({ action:'request-code', email:'nobody@example.com' });
const known = await post({ action:'request-code', email:'rivka@example.com' });
check('an unknown address gets the same answer as a real one',
      JSON.stringify(unknown.body) === JSON.stringify(known.body), `${JSON.stringify(unknown.body)} vs ${JSON.stringify(known.body)}`);
check('...and no email is sent to it', !sent.some(s => s.to === 'nobody@example.com'));

reset();
await post({ action:'request-code', email:'blocked@example.com' });
check('a blocked client is sent nothing', sent.length === 0);

// --- using the code ---------------------------------------------------------------------------------
reset();
await post({ action:'request-code', email:'rivka@example.com' });
let code = codeFor('rivka@example.com');
res = await post({ action:'verify-code', email:'rivka@example.com', code });
check('the right code signs them in', !!res.body?.token, JSON.stringify(res.body).slice(0,120));
check('...and returns their sessions', res.body?.found === true && res.body?.name === 'Rivka Stern');
check('the code cannot be used twice',
      !(await post({ action:'verify-code', email:'rivka@example.com', code })).body?.token);

// --- wrong codes -----------------------------------------------------------------------------------------
reset();
await post({ action:'request-code', email:'rivka@example.com' });
code = codeFor('rivka@example.com');
const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
res = await post({ action:'verify-code', email:'rivka@example.com', code: wrong });
check('a wrong code is refused', !res.body?.token && res.statusCode === 400);
check('...with a message that does not hint at the real one', !new RegExp(code).test(res.body?.error || ''));
check('the right code still works afterwards',
      !!(await post({ action:'verify-code', email:'rivka@example.com', code })).body?.token);

// guessing is capped
reset();
await post({ action:'request-code', email:'rivka@example.com' });
code = codeFor('rivka@example.com');
for (let i = 0; i < 5; i++) await post({ action:'verify-code', email:'rivka@example.com', code:'000000' });
res = await post({ action:'verify-code', email:'rivka@example.com', code });
check('guessing is cut off after five tries, even with the right code',
      !res.body?.token && res.statusCode === 429, `${res.statusCode}`);
check('...and the code is thrown away', !codeFor('rivka@example.com'));

// --- expiry and absence -------------------------------------------------------------------------------------
reset();
res = await post({ action:'verify-code', email:'rivka@example.com', code:'123456' });
check('a code that was never issued is refused', res.statusCode === 400 && /expired/i.test(res.body?.error || ''));

// --- the request itself is bounded -----------------------------------------------------------------------------
reset();
for (let i = 0; i < 5; i++) await post({ action:'request-code', email:'rivka@example.com' });
const before = sent.length;
await post({ action:'request-code', email:'rivka@example.com' });
check('one address cannot be mailed endlessly', sent.length === before, `${before} then ${sent.length}`);

// --- a code can't be redeemed against someone else's account ------------------------------------------------------
reset();
await post({ action:'request-code', email:'rivka@example.com' });
code = codeFor('rivka@example.com');
res = await post({ action:'verify-code', email:'someone.else@example.com', code });
check('a code issued for one address cannot sign in another', !res.body?.token);

// --- the email ---------------------------------------------------------------------------------------------------
const mail = portalCodeEmail({ name:'Rivka Stern', email:'r@example.com' }, '042913');
check('the email shows the code', /042913/.test(mail.html));
check('...says it expires', /ten minutes/i.test(mail.html));
check('...says it works once', /works once/i.test(mail.html));
check('...and reassures someone who did not ask for it', /didn.t ask for it/i.test(mail.html));

// --- the page ------------------------------------------------------------------------------------------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('the sign-in form no longer asks for a phone number', !/id="portal-phone"/.test(html));
check('it asks for an email and sends a code', /action: 'request-code'/.test(html));
check('it then asks for the code', /id="portal-code"/.test(html));
check('...using the one-time-code autofill browsers offer', /autocomplete="one-time-code"/.test(html));
check('...and submits as soon as six digits are entered', /portalCode\.length === 6\) verifyPortalCode\(\)/.test(html));
check('it allows starting over with a different address', /portal-restart-btn/.test(html));
check('it never claims the address was found', /is on file, a six-digit code is on its way/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
