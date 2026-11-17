// Stripe tells us when money moves after the fact.
//
// Charges were confirmed synchronously, so nothing was outright broken — but a refund, a
// dispute, or a payment that failed later never made it back into the booking record. Heshy
// could refund a client in Stripe and this app would still show the session as charged.
//
// The endpoint registers itself: an admin action in Manage asks Stripe to create this webhook
// using the secret key the app already has, and stores the signing secret that comes back. No
// dashboard visit and no new environment variable.

import { stripe } from './_lib/stripecustomer.js';
import { kv } from '@vercel/kv';
import { mutate, SKIP_WRITE } from './_lib/store.js';
import { logError } from './_lib/errorlog.js';
import { verifySvix, applyEmailEvent } from './_lib/emailstatus.js';

// Stripe signs the raw bytes, so the body must not be parsed before it is verified.
export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export { EVENTS } from './_lib/stripeevents.js';

/** Applies one event to the booking it belongs to. Returns a short description of what changed. */
export async function applyEvent(event) {
  const obj = event.data?.object || {};
  const intentId = obj.payment_intent || obj.id;
  if (!intentId) return 'no payment intent on the event';

  // A pay-link payment has no intent id on the booking yet — the booking only learns it once the
  // payment succeeds — so the intent's own metadata is the fallback. Without this, a client who
  // paid and then closed the tab mid-3-D-Secure would never be recorded as having paid.
  const metaBookingId = obj.metadata?.bookingId || event.data?.object?.metadata?.bookingId || null;

  let note = 'no matching booking';
  await mutate(data => {
    const booking = (data.bookings || []).find(b => b.stripePaymentIntentId === intentId)
      || (metaBookingId ? (data.bookings || []).find(b => b.id === metaBookingId) : null);
    if (!booking) return SKIP_WRITE;

    if (event.type === 'charge.refunded') {
      const refunded = (obj.amount_refunded || 0) / 100;
      const total = (obj.amount || 0) / 100;
      booking.refundedAmount = refunded;
      booking.refundedAt = Date.now();
      if (total && refunded >= total) {
        booking.status = 'refunded';
        booking.amount = 0;
        note = `fully refunded ($${refunded})`;
      } else {
        note = `partially refunded ($${refunded})`;
      }
    } else if (event.type === 'charge.dispute.created') {
      booking.disputed = true;
      booking.disputedAt = Date.now();
      note = 'marked disputed';
    } else if (event.type === 'charge.dispute.closed') {
      booking.disputeOutcome = obj.status || 'closed';
      note = `dispute ${obj.status || 'closed'}`;
    } else if (event.type === 'payment_intent.succeeded') {
      // Backstop for pay links: the page confirms the payment itself, but a client who closes
      // the tab during the bank's 3-D Secure step never gets to. Stripe tells us either way.
      if (booking.status === 'charged') { note = 'already recorded'; return SKIP_WRITE; }
      booking.status = 'charged';
      booking.amount = (obj.amount_received ?? obj.amount ?? 0) / 100;
      booking.paidByClient = true;
      booking.paidAt = Date.now();
      booking.stripePaymentIntentId = intentId;
      delete booking.lastDeclineCode;
      note = `payment recorded ($${booking.amount})`;
    } else if (event.type === 'payment_intent.payment_failed') {
      booking.lastPaymentError = (obj.last_payment_error?.message || 'The payment failed.').slice(0, 300);
      booking.lastPaymentErrorAt = Date.now();
      note = 'payment failure recorded';
    } else {
      return SKIP_WRITE;
    }
  });
  return note;
}

/**
 * Resend's delivery reports arrive here too, at /api/email-webhook, which vercel.json rewrites
 * onto this same function. Two webhooks share one function because the Hobby plan allows twelve
 * and this app is at twelve; they share nothing else.
 *
 * Told apart by the signature headers, and handled inside this block, which returns in every
 * case — so a Resend event can never fall through into Stripe's handling, or the reverse. Each
 * is verified against its own secret with its own scheme before anything is acted on.
 */
async function handleResend(req, res) {
  const secret = await kv.get('resend-webhook-secret');
  if (!secret) return res.status(503).json({ error: 'This endpoint is not set up yet.' });

  const body = (await rawBody(req)).toString('utf8');
  if (!verifySvix(body, req.headers, secret)) {
    await logError('resend-webhook', new Error('Signature verification failed'), { reason: 'bad signature' });
    return res.status(400).json({ error: 'Signature verification failed.' });
  }

  let event;
  try { event = JSON.parse(body); }
  catch (e) { return res.status(400).json({ error: 'Unreadable body.' }); }

  // Svix retries, so the same event can arrive more than once.
  const seenKey = 'resend-event:' + (req.headers['svix-id'] || '');
  try {
    if (await kv.get(seenKey)) return res.status(200).json({ ok: true, duplicate: true });
    await kv.set(seenKey, 1, { ex: 60 * 60 * 24 * 7 });
  } catch (e) { /* if the guard is unavailable, still handle the event */ }

  try {
    const note = await applyEmailEvent(event);
    return res.status(200).json({ ok: true, note });
  } catch (err) {
    await logError('resend-webhook', err, { eventType: event?.type });
    return res.status(500).json({ error: 'Could not record that.' });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Resend signs with Svix; Stripe with its own header. Checked first and returned from inside.
  if (req.headers['svix-id'] && req.headers['svix-signature']) return handleResend(req, res);

  const secret = await kv.get('stripe-webhook-secret');
  if (!secret) return res.status(503).json({ error: 'This endpoint is not set up yet.' });

  let event;
  try {
    const body = await rawBody(req);
    event = stripe.webhooks.constructEvent(body, req.headers['stripe-signature'], secret);
  } catch (err) {
    // An unverified event is not from Stripe, whatever it claims. Never act on one.
    await logError('stripe-webhook', err, { reason: 'signature verification failed' });
    return res.status(400).json({ error: 'Signature verification failed.' });
  }

  // Stripe retries, so the same event can arrive more than once. Acting twice on a refund would
  // double-count it.
  const seenKey = 'stripe-event:' + event.id;
  try {
    const already = await kv.get(seenKey);
    if (already) return res.status(200).json({ ok: true, duplicate: true });
    await kv.set(seenKey, 1, { ex: 60 * 60 * 24 * 30 });
  } catch (e) { /* if the guard is unavailable, still handle the event */ }

  try {
    const note = await applyEvent(event);
    return res.status(200).json({ ok: true, note });
  } catch (err) {
    await logError('stripe-webhook', err, { eventType: event.type, eventId: event.id });
    // 500 asks Stripe to try again later rather than dropping it.
    return res.status(500).json({ error: 'Could not process that event.' });
  }
}
