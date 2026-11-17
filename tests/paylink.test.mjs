// Paying from a link.
//
// Charging a saved card while the client is nowhere near it is the shape banks decline for
// fraud — that is what produced do_not_honor from Chase on a real invoice. When the cardholder
// opens a link and presses Pay, the bank sees them approving it and can run 3-D Secure, which
// is what actually clears the decline.
//
// The risk this file guards is money: a link that can be edited into a different price, a
// payment credited to the wrong session, or a session marked paid when it wasn't.
import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import handler from '../api/create-setup-intent.js';
import { applyEvent } from '../api/stripe-webhook.js';
import { issuePayToken, readPayToken, payableFor, revokePayToken } from '../api/_lib/paylink.js';
import { chargeDeclinedEmail } from '../api/_lib/email.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

process.env.RESEND_API_KEY = 'test';
process.env.SITE_URL = 'https://heshy-booking.vercel.app';

let store = new Map(), appData, sent = [], intents = [], retrieved = {};

globalThis.fetch = async (url, opts) => {
  if (String(url).includes('resend.com')) {
    const b = JSON.parse(opts?.body || '{}');
    sent.push({ to: b.to?.[0], subject: b.subject, html: b.html });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};
kv.get = async k => (k === 'app-data' ? appData : (store.has(k) ? store.get(k) : null));
kv.set = async (k, v, o) => {
  if (k === 'app-data') { appData = v; return 'OK'; }
  if (o?.nx && store.has(k)) return null;
  store.set(k, v); return 'OK';
};
kv.del = async k => { store.delete(k); return 1; };
kv.incr = async k => { const v = (Number(store.get(k)) || 0) + 1; store.set(k, v); return v; };
kv.expire = async () => 1;
kv.lpush = async () => 1; kv.ltrim = async () => 'OK'; kv.lrange = async () => [];

// A stand-in Stripe that records what it was asked to do.
const { stripe } = await import('../api/_lib/stripecustomer.js');
stripe.paymentIntents.create = async (params, opts) => {
  intents.push({ params, opts });
  const id = 'pi_' + (intents.length);
  const made = { id, status: 'requires_confirmation', amount: params.amount, metadata: params.metadata, client_secret: id + '_secret' };
  retrieved[id] = made;
  return made;
};
stripe.paymentIntents.retrieve = async id => retrieved[id] || null;

function reset() {
  store = new Map(); sent = []; intents = []; retrieved = {};
  appData = {
    clients: [{ id:'c1', name:'Yoily Klein', email:'y@example.com' }],
    bookings: [{
      id:'b1', clientId:'c1', clientName:'Yoily Klein', clientEmail:'y@example.com',
      date:'2026-11-17', time:'11:00', durationMin:60, actualMinutes:135, type:'in-person',
      status:'scheduled', stripeCustomerId:'cus_1'
    }],
    settings: { hourlyRate: 500, billingMode: 'actual' }
  };
}
function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.setHeader = () => r;
  return r;
}
async function call(body) {
  const res = mockRes();
  await handler({ method:'POST', query:{}, headers:{}, body }, res);
  return res;
}

// --- the token --------------------------------------------------------------------------------
reset();
const tok = await issuePayToken('b1');
check('a pay token is issued', typeof tok === 'string' && tok.length >= 24, String(tok));
check('...and resolves back to its booking', await readPayToken(tok) === 'b1');
check('...and is long enough not to be guessed', tok.length >= 48, String(tok.length));
// A client who gets two emails must not end up with two links where only one works.
check('re-issuing returns the same link', await issuePayToken('b1') === tok);
check('a made-up token resolves to nothing', await readPayToken('deadbeef'.repeat(6)) === null);
check('a short token is refused outright', await readPayToken('abc') === null);
check('no token resolves to nothing', await readPayToken(undefined) === null);
await revokePayToken(tok, 'b1');
check('a revoked token stops working', await readPayToken(tok) === null);

// --- what is owed, worked out fresh ---------------------------------------------------------------
reset();
const owed = payableFor(appData, 'b1');
check('the amount comes from the booking, not the link', owed.state === 'owed');
// 135 min at $500/hr = 2.25 h = $1125
check('...and is the real figure', owed.amount === 1125, String(owed.amount));
check('...with the minutes it was worked out from', owed.minutes === 135, String(owed.minutes));
check('an unknown booking is not payable', payableFor(appData, 'nope').state === 'unknown');
check('a cancelled session is not payable', payableFor({...appData, bookings:[{...appData.bookings[0], cancelled:true}]}, 'b1').state === 'cancelled');
check('an already-charged session is not payable again', payableFor({...appData, bookings:[{...appData.bookings[0], status:'charged'}]}, 'b1').state === 'paid');
check('a complimentary session is not payable', payableFor({...appData, bookings:[{...appData.bookings[0], comped:true}]}, 'b1').state === 'comped');

// --- the page's view of it --------------------------------------------------------------------------
reset();
const t2 = await issuePayToken('b1');
let res = await call({ action:'pay-info', token: t2 });
check('the pay page is told the amount', res.body?.amount === 1125, JSON.stringify(res.body));
check('...the length', res.body?.minutes === 135);
check('...and the client\'s first name only', res.body?.name === 'Yoily', res.body?.name);
check('an invalid token gets a state, not a crash', (await call({ action:'pay-info', token:'x'.repeat(30) })).body?.state === 'unknown');

// A link outlives the problem it was sent about, so arriving after paying is normal, not an error.
appData.bookings[0].status = 'charged';
res = await call({ action:'pay-info', token: t2 });
check('a link opened after paying says so rather than erroring', res.body?.state === 'paid', JSON.stringify(res.body));

// --- creating the payment ------------------------------------------------------------------------------
reset();
const t3 = await issuePayToken('b1');
res = await call({ action:'pay-intent', token: t3 });
check('a payment can be started', !!res.body?.clientSecret, JSON.stringify(res.body));
check('...for the amount actually owed', intents[0].params.amount === 112500, String(intents[0].params.amount));
// This is the whole point: the cardholder is present, so the bank may run 3-D Secure.
check('...on-session, so the bank can ask the client to confirm', intents[0].params.off_session === undefined);
check('...tied to the booking, so it can be matched later', intents[0].params.metadata.bookingId === 'b1');
check('...against their existing Stripe customer', intents[0].params.customer === 'cus_1');
check('...keeping the card for next time', intents[0].params.setup_future_usage === 'off_session');
// Reloading the page must not start a second payment for the same session.
check('...idempotently', /paylink-b1-112500/.test(intents[0].opts.idempotencyKey));

// The amount must never come from the browser.
reset();
const t4 = await issuePayToken('b1');
await call({ action:'pay-intent', token: t4, amount: 1, cents: 1 });
check('an amount sent by the browser is ignored', intents[0].params.amount === 112500, String(intents[0].params.amount));

reset();
appData.bookings[0].status = 'charged';
const t5 = await issuePayToken('b1');
res = await call({ action:'pay-intent', token: t5 });
check('an already-paid session cannot be paid twice', res.statusCode === 400, JSON.stringify(res.body));

// --- recording the payment -------------------------------------------------------------------------------
reset();
const t6 = await issuePayToken('b1');
await call({ action:'pay-intent', token: t6 });
retrieved['pi_1'].status = 'succeeded';
res = await call({ action:'pay-confirm', token: t6, paymentIntentId: 'pi_1' });
check('a completed payment is recorded', res.statusCode === 200, JSON.stringify(res.body));
check('...marking the session charged', appData.bookings[0].status === 'charged');
check('...for the amount Stripe actually took', appData.bookings[0].amount === 1125, String(appData.bookings[0].amount));
check('...noting the client paid it themselves', appData.bookings[0].paidByClient === true);
check('...and keeping the payment reference', appData.bookings[0].stripePaymentIntentId === 'pi_1');
check('the client gets a receipt', sent.some(s => s.to === 'y@example.com'), JSON.stringify(sent.map(s=>s.to)));
check('Heshy is told the money arrived', sent.some(s => s.to === 'heshy@catalystconsultingnyc.com' && /Paid/.test(s.subject)));
check('the link stops working once paid', await readPayToken(t6) === null);

// The browser saying "it worked" is not evidence. The server re-reads it from Stripe.
reset();
const t7 = await issuePayToken('b1');
await call({ action:'pay-intent', token: t7 });
res = await call({ action:'pay-confirm', token: t7, paymentIntentId: 'pi_1' });
check('a payment that did not succeed is not accepted', res.statusCode === 400, JSON.stringify(res.body));
check('...and the session stays unpaid', appData.bookings[0].status !== 'charged');

// A real payment for a different session must not settle this one.
reset();
const t8 = await issuePayToken('b1');
retrieved['pi_other'] = { id:'pi_other', status:'succeeded', amount: 112500, metadata:{ bookingId:'someone-else' } };
res = await call({ action:'pay-confirm', token: t8, paymentIntentId: 'pi_other' });
check("another session's payment cannot settle this one", res.statusCode === 400, JSON.stringify(res.body));
check('...and it stays unpaid', appData.bookings[0].status !== 'charged');

reset();
res = await call({ action:'pay-confirm', token: 'y'.repeat(30), paymentIntentId:'pi_1' });
check('an invalid token cannot confirm anything', res.statusCode === 404);

// --- the webhook backstop ----------------------------------------------------------------------------------
// A client who closes the tab during their bank's confirmation step never reports back.
reset();
const ev = { type:'payment_intent.succeeded', data:{ object:{ id:'pi_z', amount:112500, amount_received:112500, metadata:{ bookingId:'b1' } } } };
const note = await applyEvent(ev);
check('a payment is recorded even if the browser never reports back', appData.bookings[0].status === 'charged', note);
check('...found by the booking id on the payment', appData.bookings[0].stripePaymentIntentId === 'pi_z');
check('...for the right amount', appData.bookings[0].amount === 1125, String(appData.bookings[0].amount));
// Both paths can fire for the same payment; it must be recorded once.
const again = await applyEvent(ev);
check('a repeat of the same event changes nothing', /already recorded/.test(again), again);
check('...and does not double the amount', appData.bookings[0].amount === 1125);

// --- the email carries the link -------------------------------------------------------------------------------
const mail = chargeDeclinedEmail(
  { id:'b1', date:'2026-11-17', durationMin:60, actualMinutes:135, clientName:'Yoily Klein' },
  { code:'do_not_honor', amount:1125 }, {}, 'https://heshy-booking.vercel.app/#pay/abc123');
check('the decline email offers paying directly', /#pay\/abc123/.test(mail.html));
check('...with the amount on the button, so there is no surprise', /Pay \$1125\.00 now/.test(mail.html));
check('...explaining why that works when the charge didn\'t', /your bank can see it's you paying/.test(mail.html));
check('...and still offers updating the card', /#portal/.test(mail.html));
// Without a link the email must still work rather than render a dead button.
const noLink = chargeDeclinedEmail({ id:'b1', date:'2026-11-17', durationMin:60, clientName:'Y' }, { code:'do_not_honor', amount:10 }, {});
check('an email with no pay link falls back to the card update', /Update your card/.test(noLink.html) && !/#pay\//.test(noLink.html));

const srv = readFileSync(new URL('../api/charge-booking.js', import.meta.url), 'utf8');
check('a pay link is minted when a charge declines', /issuePayToken\(bookingId\)/.test(srv));
check('...and a failure to mint one never breaks the email', /issuePayToken\(bookingId\)\.catch/.test(srv));

// --- the page -------------------------------------------------------------------------------------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('the page answers a pay link', /openPayLink/.test(html));
check('...only for a properly-shaped token', /\^#pay\\\/\(\[a-f0-9\]\{24,\}\)\$/.test(html));
check('...before any other route, so a pay link always lands on the pay page', html.indexOf('if(!openPayLink())') < html.indexOf('openStrengthsFromLink()){\n    if(openPortalFromGoogle'));
check('the amount is fetched, never read from the link', /action:'pay-info', token: payToken/.test(html));
// Clicking from an email loads the page fresh. Pasting the link into a tab already on the site
// changes only the hash, which reloads nothing — so that has to be listened for too.
check('a pay link arriving without a reload still opens the page', /addEventListener\('hashchange'/.test(html));
check('...and does not re-enter the page it is already on', /view !== 'pay' &&/.test(html));
check('the amount is the biggest thing on the page', /\.pay-amount\{font-size:38px/.test(html));
check('the button says what will be charged', /'Pay '\+amt/.test(html));
check('the bank\'s confirmation step is handled', /stripe\.confirmCardPayment/.test(html));
check('...and the client is warned it may happen', /Your bank may ask you to confirm/.test(html));
check('the payment is reported to the server for checking', /action:'pay-confirm'/.test(html));
check('a paid link says so instead of erroring', /already been paid/.test(html));
check('an expired link says so plainly', /expired or isn't valid/.test(html));
check('a failure states nothing was charged', /Nothing has been charged/.test(html));
check('the card field is rebuilt after each render', /host\.childElementCount > 0/.test(html));
check('card details are said to stay with Stripe', /never reach this site/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
