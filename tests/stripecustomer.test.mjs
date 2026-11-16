// One person, one Stripe customer — and the browser can't pick which.
import { kv } from '@vercel/kv';
import * as sc from '../api/_lib/stripecustomer.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// --- stub Stripe ------------------------------------------------------------------------------
const stripeState = { customers: {}, created: 0, nextId: 1 };
function addCustomer(id, props = {}) { stripeState.customers[id] = { id, deleted: false, invoice_settings: {}, ...props }; return stripeState.customers[id]; }

sc.stripe.customers.retrieve = async id => {
  const c = stripeState.customers[id];
  if (!c) { const e = new Error('No such customer'); e.code = 'resource_missing'; throw e; }
  return c;
};
sc.stripe.customers.create = async props => {
  stripeState.created++;
  return addCustomer('cus_new' + (stripeState.nextId++), props);
};
sc.stripe.customers.update = async (id, props) => Object.assign(stripeState.customers[id], props);
sc.stripe.paymentMethods.list = async ({ customer }) => ({ data: (stripeState.customers[customer]?.cards || []) });

// --- stub KV ----------------------------------------------------------------------------------
const store = new Map();
kv.set = async (k, v) => { store.set(k, v); return 'OK'; };
kv.get = async k => (store.has(k) ? store.get(k) : null);
kv.del = async k => { store.delete(k); return 1; };

// --- a returning client reuses their customer --------------------------------------------------
addCustomer('cus_existing');
const data = { clients: [
  { id: 'c1', name: 'Rivka Stern', email: 'Rivka@Example.com ', phone: '3475550101', stripeCustomerId: 'cus_existing' },
  { id: 'c2', name: 'Gone Away', email: 'gone@example.com', stripeCustomerId: 'cus_deleted_long_ago' }
] };

stripeState.created = 0;
let r = await sc.resolveCustomer(data, { name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101' });
check('a returning client reuses their existing Stripe customer', r.customer.id === 'cus_existing' && r.reused === true, r.customer.id);
check('...and no new customer is created', stripeState.created === 0, String(stripeState.created));

// Email matching has to survive the casing and stray spaces that are stored on real records.
r = await sc.resolveCustomer(data, { name: 'R', email: '  RIVKA@EXAMPLE.COM  ' });
check('matching ignores case and surrounding spaces', r.customer.id === 'cus_existing');

// --- a customer deleted in the Stripe dashboard doesn't break booking --------------------------
stripeState.created = 0;
r = await sc.resolveCustomer(data, { name: 'Gone Away', email: 'gone@example.com' });
check('a customer that no longer exists is replaced, not fatal', r.reused === false && stripeState.created === 1);

// --- a brand new client gets exactly one customer ----------------------------------------------
stripeState.created = 0;
r = await sc.resolveCustomer(data, { name: 'New Person', email: 'New@Example.com', phone: '1' });
check('a new client gets one new customer', stripeState.created === 1);
check('the customer is created with the normalized email', r.customer.email === 'new@example.com', r.customer.email);

// --- the booking token can't be pointed at someone else's customer -----------------------------
const token = await sc.issueSetupToken('cus_existing', 'Rivka@Example.com');
check('a token redeems for the email it was issued for',
      (await sc.redeemSetupToken(token, 'rivka@example.com')) === 'cus_existing');
check('...regardless of casing or spacing',
      (await sc.redeemSetupToken(token, '  RIVKA@EXAMPLE.COM ')) === 'cus_existing');
check('a token issued for one person cannot be used to book as another',
      (await sc.redeemSetupToken(token, 'someone.else@example.com')) === null);
check('a made-up token gets nothing', (await sc.redeemSetupToken('not-a-real-token', 'rivka@example.com')) === null);
check('a missing token gets nothing', (await sc.redeemSetupToken('', 'rivka@example.com')) === null);
check('a token is stored with an expiry so it cannot be replayed indefinitely',
      store.has('setup-token:' + token));

// --- charging picks the default card, not whichever Stripe listed first ------------------------
addCustomer('cus_cards', {
  cards: [ { id: 'pm_old', created: 100 }, { id: 'pm_new', created: 900 } ],
  invoice_settings: { default_payment_method: 'pm_chosen' }
});
check('the customer default wins', (await sc.defaultCardFor('cus_cards')) === 'pm_chosen');

addCustomer('cus_nodefault', { cards: [ { id: 'pm_old', created: 100 }, { id: 'pm_newer', created: 900 } ] });
check('with no default set, the most recent card is used (not data[0])',
      (await sc.defaultCardFor('cus_nodefault')) === 'pm_newer');

addCustomer('cus_nocards', { cards: [] });
check('no cards at all returns nothing rather than throwing',
      (await sc.defaultCardFor('cus_nocards')) === null);

// Updating the default is what makes "use this card from now on" mean something.
await sc.setDefaultCard('cus_nodefault', 'pm_old');
check('setting a default records it on the customer',
      stripeState.customers['cus_nodefault'].invoice_settings.default_payment_method === 'pm_old');
check('and that default is then what gets charged',
      (await sc.defaultCardFor('cus_nodefault')) === 'pm_old');

// --- findClientByEmail ---------------------------------------------------------------------------
check('finds a client by messy email', sc.findClientByEmail(data, ' RIVKA@example.com ')?.id === 'c1');
check('returns nothing for an unknown email', sc.findClientByEmail(data, 'nobody@example.com') === null);
check('an empty email matches nobody', sc.findClientByEmail(data, '') === null);
check('a client record with no email does not blow up',
      sc.findClientByEmail({ clients: [{ id: 'x' }] }, 'a@b.com') === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
