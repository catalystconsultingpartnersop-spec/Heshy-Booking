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


// --- the client is told, automatically ------------------------------------------------------------
// Heshy asked for this explicitly: he doesn't chase payments, so the app has to do the telling.
const { chargeDeclinedEmail } = await import('../api/_lib/email.js');
const bk = { id:'b1', date:'2026-11-17', durationMin:60, actualMinutes:60, clientName:'Yoily Klein', clientEmail:'y@example.com' };

const dnhMail = chargeDeclinedEmail(bk, { code:'do_not_honor', amount:500 }, {});
check('the client email leads with what happened, not jargon', /didn't go through/i.test(dnhMail.html));
check('...names the amount', /\$500\.00/.test(dnhMail.html));
check('...and the session it was for', /60-minute session on 2026-11-17/.test(dnhMail.html));
check('...greets them by first name', /Hi Yoily/.test(dnhMail.html));
check('...never shows the internal decline code', !/do_not_honor/.test(dnhMail.html));
// Heshy's own correction: the app was writing reassurance in his name that he has no interest
// in giving and can't vouch for. It states the fact and stops.
check('...does not editorialise about how common declines are', !/common/i.test(dnhMail.html), dnhMail.html.slice(0,400));
check('...does not guess at what the bank was thinking', !/fraud check/i.test(dnhMail.html) && !/being cautious/i.test(dnhMail.html));
check('...just states what the bank did', /declined it without giving a reason/.test(dnhMail.html));
check('...tells them to call the number on the card', /number on the back/i.test(dnhMail.html));
check('...and does not point "below" at something that is not there', !/different card below/.test(dnhMail.html) || /Update your card/.test(dnhMail.html));
// He requires invoices paid on receipt. The app must not undercut that on his behalf.
check('...and does not tell the client there is no rush',
      !/nothing urgent/i.test(dnhMail.html) && !/whenever you get to it/i.test(dnhMail.html), dnhMail.html.slice(-400));
// "Nothing has been taken from your account yet" said nothing the headline hadn't already said,
// and "yet" read like a threat. The offer to pay another way is the only part that did work.
check('...and does not restate what the headline already said', !/Nothing has been taken/i.test(dnhMail.html));
check('...while still offering another route', /pay another way/i.test(dnhMail.html));
check('the subject says plainly what happened', /didn't go through/.test(dnhMail.subject), dnhMail.subject);
check('...and carries the amount, so it is actionable from the inbox', /\$500\.00/.test(dnhMail.subject), dnhMail.subject);
check('...and gives one clear action', /Update your card/.test(dnhMail.html));
check('...linking to the portal', /#portal/.test(dnhMail.html));
check('the subject does not call the client out', !/declined|refused|overdue/i.test(dnhMail.subject), dnhMail.subject);

// Each reason gets its own advice, written for the client rather than for Heshy.
const authMail = chargeDeclinedEmail(bk, { code:'authentication_required', amount:500 }, {});
check('a 3-D Secure decline tells the client to confirm with their bank', /approve this payment yourself/i.test(authMail.html));
const expMail = chargeDeclinedEmail(bk, { code:'expired_card', amount:500 }, {});
check('an expired card says so in the client\'s terms', /has expired/i.test(expMail.html));
check('...and differs from the generic wording', expMail.html !== dnhMail.html);
const unknownMail = chargeDeclinedEmail(bk, { code:'something_unheard_of', amount:500 }, {});
check('an unknown reason still gives the client something to do', /add a different card/i.test(unknownMail.html));

check('a name with markup is escaped', !chargeDeclinedEmail({...bk, clientName:'<script>x</script>'}, { code:'do_not_honor', amount:1 }, {}).html.includes('<script>x'));
check('a missing name still reads properly', /Hi there/.test(chargeDeclinedEmail({...bk, clientName:''}, { code:'do_not_honor', amount:1 }, {}).html));

const srv = readFileSync(new URL('../api/charge-booking.js', import.meta.url), 'utf8');
check('the client is emailed from the decline path', /notifyClientOfDecline/.test(srv));
// Pressing Charge four times must not send four identical emails.
check('...at most once per booking per reason', /nx: true/.test(srv) && /decline-notified:/.test(srv));
check('...keyed by the reason, so a genuinely new problem still sends', /decline-notified:\$\{bookingId\}:\$\{d\.code\}/.test(srv));
check('...and a failed send is allowed to be retried', /await kv\.del\(seenKey\)/.test(srv));
check('a notification failure never swallows the decline itself', /Decline notification failed/.test(srv));
check('Manage is told what actually happened to that email', /clientEmailed: emailed/.test(srv));
check('...rather than assuming it went', /return 'no-email'/.test(srv) && /return 'failed'/.test(srv));

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('Manage says when the client has been told', /has been emailed about it/.test(page));
check('...and says so plainly when they have not', /couldn't be told automatically/.test(page));
check('...and does not claim a second email was sent', /was not emailed this time/.test(page));
// The suppression is right by default and wrong when Heshy actually wants them chased, so the
// override has to exist and has to be reachable from the decline itself.
check('...and offers to send it again anyway', /data-resend-decline/.test(page));
check('...which clears the once-per-reason block', /decline-notified:\$\{resendFor\}:\$\{code\}/.test(srv));
check('...and refuses to chase a session that is already paid', /already been paid/.test(srv));

// --- retrying a declined charge must actually reach the bank -------------------------------------
//
// This was live and serious. Stripe caches an idempotent response for 24 hours, so a key of
// booking + amount + card meant pressing Charge again replayed the stored decline without
// contacting the issuer: same red error, nothing new in Stripe's dashboard, and a card the
// client had since cleared with their bank looked dead for a day. Retrying the NEXT day worked,
// which is what made it look like the card rather than the code.
check('the idempotency key counts the attempt', /idempotencyKey: `charge-\$\{booking\.id\}-\$\{amountCents\}-\$\{paymentMethodId\}-\$\{booking\.chargeAttempt \|\| 0\}`/.test(srv));
check('...and the count moves on only after a decline',
      /b\.chargeAttempt = \(b\.chargeAttempt \|\| 0\) \+ 1/.test(srv) &&
      srv.indexOf('b.chargeAttempt = (b.chargeAttempt || 0) + 1') > srv.indexOf("err.type === 'StripeCardError'"));
check('...so a charge that succeeded but was not recorded is never charged twice',
      !/chargeAttempt[^\n]*\+ 1/.test(srv.slice(0, srv.indexOf('paymentIntents.create'))));
check('Manage is told which attempt this was', /attempts/.test(srv) && /chargeProblem\.attempts/.test(page));

// The link a client is sent must be on Heshy's own domain, not the deploy host.
check('emails link to the real site', !/heshy-booking\.vercel\.app/.test(srv));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
