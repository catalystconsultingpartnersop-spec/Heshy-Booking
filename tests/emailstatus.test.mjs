// What became of an email after it left.
//
// "The client has been emailed" only ever meant Resend accepted it — not that it arrived, and
// not that anyone read it. The outcome that mattered most was the invisible one: a bounce. A
// wrong address on file would leave Heshy waiting for a payment nobody was ever asked for.
//
// Two risks here. One, a forged event: anything can POST to a public URL, and an unverified
// "delivered" would be a lie shown on the session. Two, an event credited to the wrong booking.
import { kv } from '@vercel/kv';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifySvix, applyEmailEvent, statusFor } from '../api/_lib/emailstatus.js';
import handler from '../api/stripe-webhook.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

let store = new Map(), appData;
kv.get = async k => (k === 'app-data' ? appData : (store.has(k) ? store.get(k) : null));
kv.set = async (k, v, o) => { if (k === 'app-data') { appData = v; return 'OK'; } if (o?.nx && store.has(k)) return null; store.set(k, v); return 'OK'; };
kv.del = async k => { store.delete(k); return 1; };
kv.lpush = async () => 1; kv.ltrim = async () => 'OK'; kv.lrange = async () => [];
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-of-decent-length').toString('base64');

function sign(body, { id = 'msg_1', ts = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + sig };
}

function reset() {
  store = new Map();
  store.set('resend-webhook-secret', SECRET);
  appData = {
    clients: [{ id: 'c1', name: 'Yoily Klein', email: 'y@example.com' }],
    bookings: [{
      id: 'b1', clientId: 'c1', clientName: 'Yoily Klein', clientEmail: 'y@example.com',
      date: '2026-11-17', durationMin: 60, status: 'scheduled',
      declineEmail: { id: 'em_1', to: 'y@example.com', sentAt: 1000, status: 'Sent', detail: '', rank: 1, problem: false }
    }],
    settings: {}
  };
}

// --- the signature ------------------------------------------------------------------------------
reset();
const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_1' } });
check('a correctly signed body verifies', verifySvix(body, sign(body), SECRET));
check('a tampered body does not', verifySvix(body + ' ', sign(body), SECRET) === false);
check('a signature for a different body does not', verifySvix(body, sign('something else'), SECRET) === false);
check('the wrong secret does not', verifySvix(body, sign(body), 'whsec_' + Buffer.from('other').toString('base64')) === false);
check('a missing signature header does not', verifySvix(body, { 'svix-id': 'a', 'svix-timestamp': '1' }, SECRET) === false);
check('a missing id does not', verifySvix(body, { 'svix-timestamp': '1', 'svix-signature': 'v1,x' }, SECRET) === false);
check('no secret at all does not', verifySvix(body, sign(body), '') === false);
check('an empty secret body does not', verifySvix(body, sign(body), 'whsec_') === false);

// A valid signature replayed days later must not be accepted.
const old = Math.floor(Date.now() / 1000) - 3600;
check('an old request is refused even when signed correctly', verifySvix(body, sign(body, { ts: old }), SECRET) === false);
const future = Math.floor(Date.now() / 1000) + 3600;
check('a request from the future is refused too', verifySvix(body, sign(body, { ts: future }), SECRET) === false);
check('a nonsense timestamp is refused', verifySvix(body, { ...sign(body), 'svix-timestamp': 'soon' }, SECRET) === false);

// Svix sends one signature per active key while a secret is being rotated; any match is enough.
const multi = sign(body);
multi['svix-signature'] = 'v1,bm90dGhlcmlnaHRvbmU= ' + multi['svix-signature'];
check('one valid signature among several is accepted', verifySvix(body, multi, SECRET));
const wrongScheme = sign(body);
wrongScheme['svix-signature'] = wrongScheme['svix-signature'].replace('v1,', 'v2,');
check('a signature under an unknown scheme is ignored', verifySvix(body, wrongScheme, SECRET) === false);
// A short signature must be refused, not throw: timingSafeEqual throws on a length mismatch.
const short = sign(body); short['svix-signature'] = 'v1,YWJj';
check('a too-short signature is refused rather than throwing', verifySvix(body, short, SECRET) === false);
check('garbage in the header is refused rather than throwing', verifySvix(body, { ...sign(body), 'svix-signature': 'v1,!!!!' }, SECRET) === false);

// --- recording what happened --------------------------------------------------------------------
reset();
let note = await applyEmailEvent({ type: 'email.delivered', data: { email_id: 'em_1' }, created_at: '2026-11-17T20:05:00Z' });
check('a delivery is recorded', appData.bookings[0].declineEmail.status === 'Delivered', note);
check('...with the time it happened', appData.bookings[0].declineEmail.statusAt === Date.parse('2026-11-17T20:05:00Z'));
check('...and is not treated as a problem', appData.bookings[0].declineEmail.problem === false);

await applyEmailEvent({ type: 'email.opened', data: { email_id: 'em_1' } });
check('an open is recorded', appData.bookings[0].declineEmail.status === 'Opened');
check('...and noted separately', appData.bookings[0].declineEmail.opened === true);

// Events can arrive out of order. "Opened" must not be downgraded by a late "delivered".
note = await applyEmailEvent({ type: 'email.delivered', data: { email_id: 'em_1' } });
check('a late delivery does not undo an open', appData.bookings[0].declineEmail.status === 'Opened', note);

// --- the one that actually matters ------------------------------------------------------------------
reset();
await applyEmailEvent({ type: 'email.bounced', data: { email_id: 'em_1' } });
check('a bounce is recorded', appData.bookings[0].declineEmail.status === 'Bounced');
check('...flagged as needing attention', appData.bookings[0].declineEmail.problem === true);
check('...and says plainly that they never got it', /never got it/.test(appData.bookings[0].declineEmail.detail));
// The time is appended to the state, so the state has to be a short label, not a sentence.
check('...with the state kept short enough to append a time to', appData.bookings[0].declineEmail.status === 'Bounced');
check('...and tells him to check the address', /Check the address on file/.test(appData.bookings[0].declineEmail.detail));

// A bounce after an open is still worth knowing, so problems always win.
reset();
await applyEmailEvent({ type: 'email.opened', data: { email_id: 'em_1' } });
await applyEmailEvent({ type: 'email.bounced', data: { email_id: 'em_1' } });
check('a bounce overrides an earlier open', appData.bookings[0].declineEmail.status === 'Bounced');

reset();
await applyEmailEvent({ type: 'email.complained', data: { email_id: 'em_1' } });
check('a spam complaint is recorded as a problem', appData.bookings[0].declineEmail.problem === true);
check('...warning that later emails may not arrive', /may not reach them/.test(appData.bookings[0].declineEmail.detail));

reset();
await applyEmailEvent({ type: 'email.delivery_delayed', data: { email_id: 'em_1' } });
check('a delay is surfaced rather than hidden', appData.bookings[0].declineEmail.problem === true);

// --- never the wrong session --------------------------------------------------------------------------
reset();
note = await applyEmailEvent({ type: 'email.delivered', data: { email_id: 'some-other-email' } });
check('an event for an unknown email changes nothing', appData.bookings[0].declineEmail.status === 'Sent', note);
note = await applyEmailEvent({ type: 'email.delivered', data: {} });
check('an event with no email id changes nothing', /no email id/.test(note), note);
note = await applyEmailEvent({ type: 'contact.created', data: { email_id: 'em_1' } });
check('an event type we do not handle changes nothing', appData.bookings[0].declineEmail.status === 'Sent', note);
check('...and says so', /ignored/.test(note), note);
check('an unknown type has no status', statusFor('nonsense') === null);

// --- the endpoint ---------------------------------------------------------------------------------------
function mockReq(bodyStr, headers) {
  return {
    method: 'POST', headers, query: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(bodyStr); }
  };
}
function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.setHeader = () => r;
  return r;
}

reset();
let res = mockRes();
const good = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_1' } });
await handler(mockReq(good, sign(good)), res);
check('a signed delivery report is accepted', res.statusCode === 200, JSON.stringify(res.body));
check('...and recorded', appData.bookings[0].declineEmail.status === 'Delivered');

// Anything can POST to a public URL. An unverified "delivered" would be a lie on the session.
reset();
res = mockRes();
await handler(mockReq(good, { 'svix-id': 'x', 'svix-timestamp': String(Math.floor(Date.now()/1000)), 'svix-signature': 'v1,ZmFrZQ==' }), res);
check('a forged event is refused', res.statusCode === 400, JSON.stringify(res.body));
check('...and nothing is recorded from it', appData.bookings[0].declineEmail.status === 'Sent');

reset();
store.delete('resend-webhook-secret');
res = mockRes();
await handler(mockReq(good, sign(good)), res);
check('nothing is accepted before the secret is set', res.statusCode === 503, String(res.statusCode));

// Svix retries, so the same report can arrive twice.
reset();
const hdrs = sign(good);
await handler(mockReq(good, hdrs), mockRes());
res = mockRes();
await handler(mockReq(good, hdrs), res);
check('a repeated report is recognised as a duplicate', res.body?.duplicate === true, JSON.stringify(res.body));

reset();
res = mockRes();
const notJson = 'this is not json';
await handler(mockReq(notJson, sign(notJson)), res);
check('an unreadable body is refused', res.statusCode === 400);

// The two webhooks share one function. A Stripe event must never reach the email handler.
reset();
res = mockRes();
await handler({ method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, query: {},
                async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } }, res);
check('a Stripe-signed request is not handled as an email event', res.statusCode !== 200, String(res.statusCode));
check('...and nothing is recorded against the email', appData.bookings[0].declineEmail.status === 'Sent');
res = mockRes();
await handler({ method: 'GET', headers: {}, query: {} }, res);
check('a GET is refused', res.statusCode === 405);

// --- the id is captured when the email is sent ---------------------------------------------------------------
const srv = readFileSync(new URL('../api/charge-booking.js', import.meta.url), 'utf8');
check("the decline email's id is stored on the booking", /declineEmail = \{/.test(srv));
check('...which is what the report is matched on', /id: typeof sent === 'string' \? sent : null/.test(srv));
const mail = readFileSync(new URL('../api/_lib/email.js', import.meta.url), 'utf8');
check('sendEmail returns the id it was given', /return body\?\.id \|\| true/.test(mail));
// Every existing caller checks truthiness or `=== false`; a string keeps both working.
check('...and still returns false on failure', /console\.error\('Resend error:'[\s\S]{0,80}return false/.test(mail));

// --- the page and the plumbing ---------------------------------------------------------------------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('the session shows what became of the email', /function emailStatusHtml/.test(html));
check('...outside the red banner, so it survives a reload', /\$\{emailStatusHtml\(b\)\}/.test(html));
check('...naming who it went to', /Sent to \$\{esc\(e\.to\|\|''\)\}/.test(html));
check('...with the explanation on its own line, not glued to the time', /e\.detail \? `<div style="margin-top:3px;">/.test(html));
check('...and marking a problem in red', /email-status\.bad/.test(html));
check('...saying plainly when nothing has come back yet', /Delivery hasn't been reported back yet/.test(html));
check('Settings explains why this matters', /bounces looks exactly like one that was read/.test(html));
check('...gives the URL to paste', /resend\.com\/webhooks/.test(html) && /paste-me/.test(html));
check('...and takes the signing secret', /action:'set-resend-secret'/.test(html));

const admin = readFileSync(new URL('../api/admin-data.js', import.meta.url), 'utf8');
check('a mistyped secret is refused at the door', /whsec_\[A-Za-z0-9\+\/=\]\{16,\}/.test(admin));
const cfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
check('the email webhook has its own URL', (cfg.rewrites || []).some(r => r.source === '/api/email-webhook'));
check('...without costing a serverless function', (cfg.rewrites || [])[0].destination === '/api/stripe-webhook');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
