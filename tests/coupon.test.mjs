// A coupon that fails at the last moment must stop the booking, not bill the client full price
// while they believe they got a discount.
import { readFileSync } from 'node:fs';
import { kv } from '@vercel/kv';
import handler from '../api/create-booking.js';
import * as sc from '../api/_lib/stripecustomer.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// Keep the suite offline: confirmation emails are best-effort and would otherwise try to reach
// Resend on every booking test.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const FUTURE = (() => { const d = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); return d.toISOString().slice(0, 10); })();
const DOW = (() => { const [y,m,d] = FUTURE.split('-').map(Number); return new Date(Date.UTC(y, m-1, d)).getUTCDay(); })();

function baseData(coupons) {
  return {
    clients: [{ id: 'c1', name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101', stripeCustomerId: 'cus_x' }],
    bookings: [],
    availability: { virtual: [{ id: 'r1', days: [DOW], start: '09:00', end: '17:00' }], 'in-person': [] },
    overrides: [], blockedDates: [],
    settings: { hourlyRate: 500, durationOptions: [60], minLeadHours: 0, coupons }
  };
}

let saved = null;
function wire(data) {
  saved = null;
  kv.get = async k => (k === 'app-data' ? JSON.parse(JSON.stringify(data)) : null);
  kv.set = async (k, v) => { if (k === 'app-data') saved = v; return 'OK'; };
  kv.del = async () => 1;
}
// The setup token is redeemed for real, so these also prove the token path works end to end.
sc.stripe.customers.retrieve = async id => ({ id, deleted: false, invoice_settings: {} });

function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}
// A client may only book flush against an edge of an open stretch, so these use 09:00 — the
// start of the 09:00-17:00 window this fixture opens.
async function book(couponCode, token, time = '09:00') {
  const res = mockRes();
  await handler({ method: 'POST', query: {}, headers: {}, body: {
    date: FUTURE, time, durationMin: 60, type: 'virtual',
    name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101',
    setupToken: token, couponCode
  } }, res);
  return res;
}

// --- a used-up coupon stops the booking --------------------------------------------------------
const tokenStore = new Map();
kv.set = async (k, v) => { tokenStore.set(k, v); return 'OK'; };
kv.get = async k => tokenStore.get(k) ?? null;
const token = await sc.issueSetupToken('cus_x', 'rivka@example.com');

wire(baseData([{ code: 'FRIEND', discountType: 'percent', discountValue: 50, maxUses: 1, usedCount: 1 }]));
kv.get = async k => (k === 'app-data' ? JSON.parse(JSON.stringify(baseData([{ code: 'FRIEND', discountType: 'percent', discountValue: 50, maxUses: 1, usedCount: 1 }]))) : tokenStore.get(k) ?? null);

let res = await book('FRIEND', token);
check('an exhausted coupon stops the booking', res.statusCode === 409, `status ${res.statusCode}`);
check('...and says why', /usage limit/i.test(res.body?.error || ''), res.body?.error);
check('...and is flagged so the page can clear the code', res.body?.couponRejected === true);
check('...and nothing was saved', saved === null);

// --- a code that does not exist ------------------------------------------------------------------
const noCoupons = baseData([]);
kv.get = async k => (k === 'app-data' ? JSON.parse(JSON.stringify(noCoupons)) : tokenStore.get(k) ?? null);
saved = null;
res = await book('MADEUP', token);
check('an unknown code stops the booking', res.statusCode === 409 && res.body?.couponRejected === true, `status ${res.statusCode}`);
check('...and nothing was saved', saved === null);

// --- a coupon this client already used ------------------------------------------------------------
const usedBy = baseData([{ code: 'ONCE', discountType: 'percent', discountValue: 50, usedByEmails: ['rivka@example.com'] }]);
kv.get = async k => (k === 'app-data' ? JSON.parse(JSON.stringify(usedBy)) : tokenStore.get(k) ?? null);
saved = null;
res = await book('ONCE', token);
check('a code the client already used stops the booking', res.statusCode === 409);
check('...with a reason they can act on', /already used/i.test(res.body?.error || ''), res.body?.error);

// --- a valid coupon still books normally -----------------------------------------------------------
const good = baseData([{ code: 'HALF', discountType: 'percent', discountValue: 50, maxUses: 10, usedCount: 0 }]);
kv.get = async k => (k === 'app-data' ? JSON.parse(JSON.stringify(good)) : tokenStore.get(k) ?? null);
saved = null;
res = await book('HALF', token);
check('a valid coupon books normally', res.statusCode === 200, `status ${res.statusCode} ${JSON.stringify(res.body)}`);
check('...and records the discount on the booking',
      saved?.bookings?.[0]?.couponDiscount?.type === 'percent' && saved.bookings[0].couponDiscount.value === 50);
check('...and marks the code used', saved?.settings?.coupons?.[0]?.usedCount === 1);

// --- no coupon at all is untouched ------------------------------------------------------------------
kv.get = async k => (k === 'app-data' ? JSON.parse(JSON.stringify(baseData([]))) : tokenStore.get(k) ?? null);
saved = null;
res = await book('', token);
check('booking without a coupon still works', res.statusCode === 200, `status ${res.statusCode} ${JSON.stringify(res.body)}`);

// --- one customer per person, agreed between the client record and the booking -------------------------
check('the booking and the client record point at the same Stripe customer',
      saved?.bookings?.[0]?.stripeCustomerId === saved?.clients?.[0]?.stripeCustomerId,
      `booking ${saved?.bookings?.[0]?.stripeCustomerId} vs client ${saved?.clients?.[0]?.stripeCustomerId}`);
check('...and it is the customer the card was actually saved against',
      saved?.bookings?.[0]?.stripeCustomerId === 'cus_x', saved?.bookings?.[0]?.stripeCustomerId);

// A second booking by the same person must not mint a second customer.
const afterFirst = JSON.parse(JSON.stringify(saved)); // snapshot, since `saved` is reset below
kv.get = async k => (k === 'app-data' ? JSON.parse(JSON.stringify(afterFirst)) : tokenStore.get(k) ?? null);
const firstCustomer = afterFirst.clients[0].stripeCustomerId;
// wire() replaced kv.set with an app-data-only stub, so restore token storage first.
kv.set = async (k, v) => { if (k === 'app-data') saved = v; else tokenStore.set(k, v); return 'OK'; };
const token2 = await sc.issueSetupToken('cus_x', 'rivka@example.com');
saved = null;
// The first booking holds 09:00-10:00, so 10:00 is the start edge of what's left.
res = await book('', token2, '10:00');
check('a second booking by the same client reuses the same customer',
      res.statusCode === 200 && saved?.clients?.length === 1 && saved.clients[0].stripeCustomerId === firstCustomer,
      `status ${res.statusCode}, ${saved?.clients?.length} client(s), customer ${saved?.clients?.[0]?.stripeCustomerId}`);

// --- the booking refuses a token that is missing or belongs to someone else ---------------------------
saved = null;
res = await book('', 'not-a-real-token');
check('a bad setup token is refused', res.statusCode === 400 && saved === null, `status ${res.statusCode}`);

const otherToken = await sc.issueSetupToken('cus_someone_else', 'other@example.com');
saved = null;
res = await book('', otherToken);
check("another person's setup token cannot be used to book", res.statusCode === 400 && saved === null);

// --- the page clears the code and tells the client, rather than booking silently -----------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('the page handles a rejected coupon', /bookingData\.couponRejected/.test(html));
check('...clears the code so re-pressing Book is a deliberate choice', /couponRejected\)\{[\s\S]{0,200}couponCode = ''/.test(html));
check('...and tells them nothing was charged', /has not been charged/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
