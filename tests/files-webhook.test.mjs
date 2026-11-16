// Two things that used to need a human: making stored files unguessable, and hearing from
// Stripe when money moves after a charge. The app does both itself.
import { kv } from '@vercel/kv';
import { isLegacyPath } from '../api/_lib/files.js';
import { EVENTS } from '../api/_lib/stripeevents.js';
import { applyEvent } from '../api/stripe-webhook.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// --- telling an old path from a new one --------------------------------------------------------
const NEW = 'https://abc.public.blob.vercel-storage.com/wg-pdfs/0123456789abcdef0123456789abcdef/report.pdf';
const OLD = 'https://abc.public.blob.vercel-storage.com/wg-pdfs/1756412345678-rivka_report.pdf';
const OLDREC = 'https://abc.public.blob.vercel-storage.com/recordings/bk12345/chunk-00001.webm';
check('a timestamped path is recognised as old', isLegacyPath(OLD));
check('a per-booking recording path is recognised as old', isLegacyPath(OLDREC));
check('a random path is recognised as current', !isLegacyPath(NEW));
check('a PDF still inline in the record counts as old', isLegacyPath('data:application/pdf;base64,JVBERi'));
check('an unrelated url is left alone', !isLegacyPath('https://example.com/x.pdf'));
check('nothing in, nothing out', !isLegacyPath('') && !isLegacyPath(null) && !isLegacyPath(undefined));
// 32 hex characters is the thing that makes a path unguessable; a shorter one must not pass.
check('a short hex segment does not count as random',
      isLegacyPath('https://abc.public.blob.vercel-storage.com/wg-pdfs/0123abcd/report.pdf'));

// --- the Stripe events we ask for ---------------------------------------------------------------
check('refunds are covered', EVENTS.includes('charge.refunded'));
check('disputes are covered', EVENTS.includes('charge.dispute.created') && EVENTS.includes('charge.dispute.closed'));
check('late payment failures are covered', EVENTS.includes('payment_intent.payment_failed'));
check('nothing is asked for that is not handled', EVENTS.length === 4);

// --- applying an event to the right booking --------------------------------------------------------
let appData;
kv.get = async k => (k === 'app-data' ? appData : null);
kv.set = async (k, v) => { if (k === 'app-data') appData = v; return 'OK'; };
kv.del = async () => 1;
function reset() {
  appData = { bookings: [
    { id: 'b1', stripePaymentIntentId: 'pi_1', status: 'charged', amount: 500, clientName: 'Rivka' },
    { id: 'b2', stripePaymentIntentId: 'pi_2', status: 'charged', amount: 250, clientName: 'Yoily' }
  ], clients: [] };
}
const ev = (type, object) => ({ id: 'evt_' + Math.random(), type, data: { object } });

reset();
let note = await applyEvent(ev('charge.refunded', { payment_intent: 'pi_1', amount: 50000, amount_refunded: 50000 }));
check('a full refund marks the session refunded', appData.bookings[0].status === 'refunded', appData.bookings[0].status);
check('...and zeroes the amount', appData.bookings[0].amount === 0);
check('...and records how much came back', appData.bookings[0].refundedAmount === 500);
check('...and says so', /fully refunded/.test(note), note);
check('...touching nobody else', appData.bookings[1].status === 'charged');

reset();
note = await applyEvent(ev('charge.refunded', { payment_intent: 'pi_2', amount: 25000, amount_refunded: 10000 }));
check('a partial refund is recorded without clearing the charge',
      appData.bookings[1].status === 'charged' && appData.bookings[1].refundedAmount === 100, note);
check('...and is described as partial', /partially refunded/.test(note), note);

reset();
await applyEvent(ev('charge.dispute.created', { payment_intent: 'pi_1' }));
check('a dispute is flagged on the booking', appData.bookings[0].disputed === true);
await applyEvent(ev('charge.dispute.closed', { payment_intent: 'pi_1', status: 'won' }));
check('...and its outcome recorded', appData.bookings[0].disputeOutcome === 'won');

reset();
await applyEvent(ev('payment_intent.payment_failed', { id: 'pi_1', last_payment_error: { message: 'Your card was declined.' } }));
check('a late payment failure is recorded', /declined/.test(appData.bookings[0].lastPaymentError || ''));
check('...with a timestamp', typeof appData.bookings[0].lastPaymentErrorAt === 'number');

// --- events that should change nothing -----------------------------------------------------------------
reset();
const before = JSON.stringify(appData);
check('an event for an unknown payment changes nothing',
      (await applyEvent(ev('charge.refunded', { payment_intent: 'pi_nobody', amount: 100, amount_refunded: 100 }))) === 'no matching booking'
      && JSON.stringify(appData) === before);
check('an event with no payment intent changes nothing',
      (await applyEvent(ev('charge.refunded', {}))) === 'no payment intent on the event'
      && JSON.stringify(appData) === before);
await applyEvent(ev('customer.created', { payment_intent: 'pi_1' }));
check('an event type we do not handle changes nothing', JSON.stringify(appData) === before);

// --- a refund of an unusual shape ------------------------------------------------------------------------
reset();
await applyEvent(ev('charge.refunded', { payment_intent: 'pi_1', amount: 0, amount_refunded: 0 }));
check('a zero-amount refund does not wrongly mark it refunded', appData.bookings[0].status === 'charged');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
