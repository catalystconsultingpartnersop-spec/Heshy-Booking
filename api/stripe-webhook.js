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

  let note = 'no matching booking';
  await mutate(data => {
    const booking = (data.bookings || []).find(b => b.stripePaymentIntentId === intentId);
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
