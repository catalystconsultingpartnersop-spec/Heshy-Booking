// Cancelling. Until now nobody was emailed anything — a cancelled client heard whatever Google
// Calendar happened to send, or nothing at all, and a client cancelling from their portal told
// Heshy nothing.
import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import adminHandler from '../api/admin-data.js';
import portalHandler from '../api/portal-lookup.js';
import { cancellationEmail, clientCancelledAlertEmail } from '../api/_lib/email.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

process.env.RESEND_API_KEY = 'test';
process.env.SITE_URL = 'https://heshy-booking.vercel.app';

let sent = [], mailWorks = true, store = new Map(), appData;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('resend.com')) {
    const body = JSON.parse(opts?.body || '{}');
    sent.push({ to: body.to?.[0], subject: body.subject, html: body.html });
    return { ok: mailWorks, status: mailWorks ? 200 : 500, text: async () => '', json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};
kv.get = async k => (k === 'app-data' ? appData : (store.get(k) ?? null));
kv.set = async (k, v) => { if (k === 'app-data') appData = v; else store.set(k, v); return 'OK'; };
kv.del = async k => { store.delete(k); return 1; };
kv.lpush = async () => 1; kv.ltrim = async () => 'OK'; kv.lrange = async () => [];

function reset() {
  sent = []; mailWorks = true; store = new Map();
  store.set('admin-session:tok', true);
  store.set('portal-session:psess', 'c1');
  appData = {
    clients: [{ id: 'c1', name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101' }],
    bookings: [{ id: 'b1', clientId: 'c1', clientName: 'Rivka Stern', clientEmail: 'rivka@example.com',
                 date: '2099-03-04', time: '11:00', durationMin: 60, type: 'virtual', status: 'scheduled' }],
    availability: { virtual: [], 'in-person': [] }, overrides: [], blockedDates: [],
    settings: { hourlyRate: 500, clientCancelCutoffHours: 3 }
  };
}
function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}

// --- Heshy cancels --------------------------------------------------------------------------
reset();
let res = mockRes();
await adminHandler({ method:'POST', query:{}, headers:{ 'x-admin-token':'tok' },
  body:{ action:'cancel-booking', bookingId:'b1' } }, res);
check('cancelling succeeds', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
check('the booking is marked cancelled', appData.bookings[0].cancelled === true);
check('it records who cancelled it', appData.bookings[0].cancelledBy === 'heshy');
check('it records when', typeof appData.bookings[0].cancelledAt === 'number');
check('the client is emailed', sent.length === 1 && sent[0].to === 'rivka@example.com', JSON.stringify(sent.map(s=>s.to)));
check('...with a subject that says cancelled', /cancelled/i.test(sent[0]?.subject || ''), sent[0]?.subject);
check('...naming the session that was cancelled', /Mar 4/.test(sent[0]?.html || ''));
check('...saying they were not charged', /haven.t been charged/i.test(sent[0]?.html || ''));
check('...and that Heshy will be in touch, since no reason was given', /be in touch/i.test(sent[0]?.html || ''));
check('no warning when it all worked', !res.body.warning, res.body.warning);

// with a reason
reset();
res = mockRes();
await adminHandler({ method:'POST', query:{}, headers:{ 'x-admin-token':'tok' },
  body:{ action:'cancel-booking', bookingId:'b1', reason:'Family emergency — so sorry.' } }, res);
check('a reason is passed on to the client', /Family emergency/.test(sent[0]?.html || ''));
check('...and recorded on the booking', appData.bookings[0].cancellationReason === 'Family emergency — so sorry.');
check('...replacing the generic line', !/He.ll be in touch to find another time/.test(sent[0]?.html || ''));

// a reason is optional
reset();
res = mockRes();
await adminHandler({ method:'POST', query:{}, headers:{ 'x-admin-token':'tok' },
  body:{ action:'cancel-booking', bookingId:'b1', reason:'   ' } }, res);
check('a blank reason is treated as none', !('cancellationReason' in appData.bookings[0]));

// --- when the email fails -----------------------------------------------------------------------
reset();
mailWorks = false;
res = mockRes();
await adminHandler({ method:'POST', query:{}, headers:{ 'x-admin-token':'tok' },
  body:{ action:'cancel-booking', bookingId:'b1' } }, res);
check('a failed email is reported, not hidden', /didn.t send/i.test(res.body?.warning || ''), res.body?.warning);
check('...and tells Heshy to contact them himself', /let them know yourself/i.test(res.body?.warning || ''));
check('...but the session is still cancelled', appData.bookings[0].cancelled === true);
mailWorks = true;

// --- a client with no email on file ------------------------------------------------------------------
reset();
appData.bookings[0].clientEmail = '';
res = mockRes();
await adminHandler({ method:'POST', query:{}, headers:{ 'x-admin-token':'tok' },
  body:{ action:'cancel-booking', bookingId:'b1' } }, res);
check('no email address is reported rather than silently skipped', /no email address on file/i.test(res.body?.warning || ''), res.body?.warning);
check('...and nothing was sent', sent.length === 0);

// --- the client cancels from their portal ---------------------------------------------------------------
reset();
res = mockRes();
await portalHandler({ method:'POST', query:{}, headers:{},
  body:{ action:'cancel-booking', token:'psess', bookingId:'b1' } }, res);
check('a client can cancel', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
check('it is recorded as their doing', appData.bookings[0].cancelledBy === 'client');
check('two emails go out', sent.length === 2, JSON.stringify(sent.map(s => s.to)));
check('...one confirming it to the client', sent.some(s => s.to === 'rivka@example.com'));
check('...and one telling Heshy', sent.some(s => s.to === 'heshy@catalystconsultingnyc.com'));
const toHeshy = sent.find(s => s.to === 'heshy@catalystconsultingnyc.com');
check('his alert names the client', /Rivka Stern/.test(toHeshy?.subject || '') || /Rivka Stern/.test(toHeshy?.html || ''));
check('...and the time that is now free', /Mar 4/.test(toHeshy?.html || ''));
check('...and links to their profile', /#manage\/client\/c1/.test(toHeshy?.html || ''));
const toClient = sent.find(s => s.to === 'rivka@example.com');
check('their own copy reads as their request, not a cancellation by Heshy',
      /as you asked/i.test(toClient?.html || ''), (toClient?.html || '').slice(0, 200));

// --- the templates themselves --------------------------------------------------------------------------------
const b = { date:'2099-03-04', time:'11:00', durationMin:60, type:'virtual', clientName:'Rivka Stern', clientId:'c1' };
const byHeshy = cancellationEmail(b, {}, { by:'heshy' });
check('the email greets them by first name', /Hi Rivka/.test(byHeshy.html));
check('it offers a way to rebook', /Book another time/.test(byHeshy.html));
check('a reason with markup in it is escaped',
      !cancellationEmail(b, {}, { by:'heshy', reason:'<script>x</script>' }).html.includes('<script>x'));
check('a client name with markup is escaped',
      !clientCancelledAlertEmail({ ...b, clientName:'<script>y</script>' }).html.includes('<script>y'));
check('a 15-minute session is described as a phone call',
      /Phone call/.test(cancellationEmail({ ...b, durationMin:15 }, {}, { by:'client' }).html));

// --- Manage asks, optionally ----------------------------------------------------------------------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('Manage warns that the client will be emailed', /client will be emailed/i.test(html));
check('...offers an optional note', /Anything to tell the client\? \(optional\)/.test(html));
check('...and backing out of that prompt cancels nothing', /if\(reason === null\) return;/.test(html));
check('...and the note is sent with the request', /bookingId: id, reason/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
