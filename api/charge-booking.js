import { kv } from '@vercel/kv';
import { mutate, SKIP_WRITE } from './_lib/store.js';
import { verifyAdminToken } from './_lib/auth.js';
import { sendEmail, receiptEmail } from './_lib/email.js';
import { logError } from './_lib/errorlog.js';
import { stripe, defaultCardFor } from './_lib/stripecustomer.js';
import { computeCharge } from './_lib/billing.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { bookingId, amount, actualMinutes } = req.body;
    const data = await kv.get('app-data');
    if (!data) return res.status(404).json({ error: 'No data found' });

    const booking = data.bookings.find(b => b.id === bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    // Guard against double-charging (double-click, network retry, etc.) — a booking that's
    // already been charged must never be charged again.
    if (booking.status === 'charged') return res.status(400).json({ error: 'This session has already been charged.' });
    if (booking.cancelled) return res.status(400).json({ error: 'This session was cancelled.' });

    if (typeof actualMinutes === 'number' && !isNaN(actualMinutes) && actualMinutes >= 0) {
      booking.actualMinutes = actualMinutes;
    }

    // The amount comes from the booking's own saved terms — billing mode, the hours actually
    // worked, and any coupon or complimentary status recorded when it was booked. It used to be
    // whatever Manage sent, which meant editing the hours silently recalculated at full price
    // and dropped the discount.
    const quote = computeCharge(booking, data.settings || {});
    const mins = quote.minutes;

    // A complimentary session never touches a card. It used to show normal charge controls, so
    // one wrong click billed a free session in full.
    if (quote.comped) {
      await mutate(fresh => {
        const b = (fresh.bookings || []).find(x => x.id === bookingId);
        if (!b) return SKIP_WRITE;
        b.status = 'charged'; b.amount = 0; b.actualMinutes = mins;
      });
      return res.status(200).json({ ok: true, amount: 0, comped: true });
    }

    let amountCents = quote.cents;
    let overridden = false;
    if (typeof amount === 'number' && !isNaN(amount) && amount >= 0) {
      const requested = Math.round(amount * 100);
      overridden = requested !== quote.cents;
      amountCents = requested;
    }
    // Defense-in-depth ceiling: even though this endpoint is admin-only, never allow a single
    // charge beyond a sane maximum, so a bug or compromised session can't trigger a runaway charge.
    // Cap is the greater of $5,000 or 3x the computed default for this session, whichever is higher.
    const MAX_CENTS = Math.max(500000, quote.cents * 3);
    if (amountCents > MAX_CENTS) {
      return res.status(400).json({ error: 'That charge amount looks too high — please double-check and try again.' });
    }

    if (!booking.stripeCustomerId) return res.status(400).json({ error: 'No card on file for this booking' });
    // The customer's default card, not whichever one Stripe happened to list first.
    const paymentMethodId = await defaultCardFor(booking.stripeCustomerId);
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'No saved card found for this customer' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: booking.stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      receipt_email: booking.clientEmail,
      description: `Clarity session, ${mins} min, ${booking.date}`
    }, {
      // Idempotency key tied to booking + amount + the specific card: an accidental double-submit
      // (same card, same amount) can never double-charge, but if a charge is declined and the
      // client saves a NEW card, the key changes and the retry genuinely attempts the new card
      // instead of replaying Stripe's cached decline from the old one.
      idempotencyKey: `charge-${booking.id}-${amountCents}-${paymentMethodId}`
    });

    // The charge has already gone through at Stripe, so this must record it. Written under the
    // lock against a fresh read, so a booking saved elsewhere in the meantime isn't erased by
    // writing back the copy this request loaded a few seconds ago.
    booking.status = 'charged';
    booking.amount = amountCents / 100;
    booking.actualMinutes = mins;
    booking.stripePaymentIntentId = paymentIntent.id;
    if (overridden) booking.amountOverridden = true;
    await mutate(fresh => {
      const b = (fresh.bookings || []).find(x => x.id === bookingId);
      if (!b) return SKIP_WRITE;
      b.status = 'charged';
      b.amount = amountCents / 100;
      b.actualMinutes = mins;
      b.stripePaymentIntentId = paymentIntent.id;
      if (overridden) b.amountOverridden = true;
    });

    try {
      const receipt = receiptEmail(booking);
      await sendEmail({ to: booking.clientEmail, subject: receipt.subject, html: receipt.html });
    } catch (e) { /* email is best-effort */ }

    res.status(200).json({ ok: true, amount: amountCents / 100 });
  } catch (err) {
    console.error('Charge error:', err);
    await logError('charge-booking', err, { bookingId: req.body?.bookingId, amount: req.body?.amount });
    // Surface Stripe's card-decline reason (safe, user-facing) but nothing internal.
    if (err && err.type === 'StripeCardError') {
      return res.status(402).json({ error: 'The card was declined.' });
    }
    res.status(500).json({ error: 'Something went wrong processing the charge. Please try again.' });
  }
}
