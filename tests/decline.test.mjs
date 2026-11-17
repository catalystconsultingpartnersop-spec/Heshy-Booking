// What Heshy is told when a card is declined.
//
// Every decline used to come back as "The card was declined." — the same sentence for an expired
// card, a card over its limit, and a bank that wants the cardholder to approve the payment
// themselves. Three different problems, three different fixes, one useless message. Worse, it
// arrived in an alert box, so dismissing it threw the reason away.
import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import { explainDecline } from '../api/charge-booking.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

const decline = (decline_code, extra = {}) => explainDecline({ type: 'StripeCardError', decline_code, ...extra });

// --- the bank wants the cardholder, which is not a decline at all ---------------------------------
const auth = explainDecline({ type: 'StripeCardError', code: 'authentication_required' });
check('a card needing the cardholder is not called a decline', !/declined/i.test(auth.message), auth.message);
check('...it says the bank wants them to approve it', /approve this payment themselves/i.test(auth.message), auth.message);
check('...and sends them to the portal, which is what actually fixes it', /portal/i.test(auth.next), auth.next);
// Charging off-session can never satisfy 3-D Secure, so pressing the button again is pointless.
check('...and is not offered as something to retry', auth.retryable === false);

// --- the cases worth telling apart -----------------------------------------------------------------
const funds = decline('insufficient_funds');
check('not enough money says so', /funds/i.test(funds.message), funds.message);
check('...and is worth retrying later', funds.retryable === true);

const expired = decline('expired_card');
check('an expired card says so', /expired/i.test(expired.message), expired.message);
check('...and asks for a new card rather than another attempt', expired.retryable === false);
check('...pointing at the portal', /portal/i.test(expired.next), expired.next);

const cvc = decline('incorrect_cvc');
check('a bad security code says so', /security code/i.test(cvc.message), cvc.message);
check('...and retrying the same details is not suggested', cvc.retryable === false);

const velocity = decline('card_velocity_exceeded');
check('hitting the card limit says so', /limit/i.test(velocity.message), velocity.message);
check('...and is worth retrying tomorrow', velocity.retryable === true);

for (const code of ['lost_card', 'stolen_card', 'pickup_card']) {
  const r = decline(code);
  check(`"${code}" asks for a different card`, /different card/i.test(r.next), r.next);
  check(`...and is not retried`, r.retryable === false);
}

const dnh = decline('do_not_honor');
check('a bank refusing without a reason says that plainly', /without a reason/i.test(dnh.message), dnh.message);
// This one worries people: it sounds like the app did something wrong, and it didn't.
check('...and makes clear it is the bank, not the app', /not that anything is wrong on your side/i.test(dnh.next), dnh.next);

const notAllowed = decline('transaction_not_allowed');
check('a card that disallows the payment type says so', /doesn't allow/i.test(notAllowed.message), notAllowed.message);

// --- anything Stripe invents later ------------------------------------------------------------------
const unknown = explainDecline({ type: 'StripeCardError', decline_code: 'something_new_from_stripe', message: "Your card's issuer did not approve it." });
check('an unrecognised code falls back to Stripe\'s own wording, not a guess',
      unknown.message === "Your card's issuer did not approve it.", unknown.message);
check('...and still carries the code for looking up', unknown.code === 'something_new_from_stripe');
check('...and still offers a next step', !!unknown.next);

const bare = explainDecline({ type: 'StripeCardError' });
check('an error with nothing on it still produces a sentence', !!bare.message && !!bare.next, JSON.stringify(bare));
check('...and never throws', typeof bare.code === 'string');

// decline_code is the specific one; code is the general one. The specific one has to win.
const both = explainDecline({ type: 'StripeCardError', code: 'card_declined', decline_code: 'insufficient_funds' });
check('the specific decline code is preferred over the general one', both.code === 'insufficient_funds', both.code);

// --- the page -----------------------------------------------------------------------------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// The button was left reading "Charging…" after a failure, so a working button looked dead.
check('the charge button gets its label back after a failure', /btn\.textContent = wasLabelled/.test(html));
check('...whatever that label was, rather than a guessed one', /const wasLabelled = btn \? btn\.textContent/.test(html));
check('...on the network-failure path too', (html.match(/restore\(\); render\(\)/g) || []).length >= 2,
      String((html.match(/restore\(\); render\(\)/g) || []).length));

check('a decline is shown on the booking, not in an alert box', /class="charge-problem"/.test(html));
check('...and no longer uses a browser alert', !/alert\('Charge failed: '/.test(html));
check('...saying plainly that nothing was taken', /Nothing was taken from the card/.test(html));
check('...and that the session is still billable', /still unbilled/.test(html));
check('...carrying the next step, not just the problem', /charge-problem-next/.test(html));
check('the button invites a retry only when retrying could work',
      /chargeProblem\.retryable \? 'Try the card again' : 'Charge anyway'/.test(html));
check('the problem is cleared when the charge is attempted again', /chargeProblem = null;/.test(html));
check('the reason is escaped rather than trusted', /esc\(chargeProblem\.message\)/.test(html));

// --- the server keeps a record ----------------------------------------------------------------------
const server = readFileSync(new URL('../api/charge-booking.js', import.meta.url), 'utf8');
check('the decline code is written to the problem log', /declineCode: err\?\.decline_code/.test(server));
check('the reason is sent to the page', /reason: d\.code/.test(server));
check('...with the next step and whether it is worth retrying', /next: d\.next, retryable: d\.retryable/.test(server));
// A decline must never mark the session charged.
check('a decline leaves the booking unbilled',
      server.indexOf("booking.status = 'charged'") < server.indexOf('} catch (err) {'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
