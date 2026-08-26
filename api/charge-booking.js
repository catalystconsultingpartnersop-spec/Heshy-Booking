import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import { verifyAdminToken } from './_lib/auth.js';
import { sendEmail, receiptEmail } from './_lib/email.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { bookingId, amount, actualMinutes } = req.body;
    const data = await kv.get('app-data');
    if (!data) return res.status(404).json({ error: 'No data found' });

    const booking = data.bookings.find(b => b.id === bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.stripeCustomerId) return res.status(400).json({ error: 'No card on file for this booking' });
    // Guard against double-charging (double-click, network retry, etc.) — a booking that's
    // already been charged must never be charged again.
    if (booking.status === 'charged') return res.status(400).json({ error: 'This session has already been charged.' });
    if (booking.cancelled) return res.status(400).json({ error: 'This session was cancelled.' });

    if (typeof actualMinutes === 'number' && !isNaN(actualMinutes) && actualMinutes >= 0) {
      booking.actualMinutes = actualMinutes;
    }
    const mins = booking.actualMinutes || booking.durationMin;
    const rate = (data.settings && data.settings.hourlyRate != null) ? data.settings.hourlyRate : 500;
    const defaultAmountCents = Math.round((mins / 60) * rate * 100);
    let amountCents = (typeof amount === 'number' && !isNaN(amount) && amount >= 0)
      ? Math.round(amount * 100)
      : defaultAmountCents;
    // Defense-in-depth ceiling: even though this endpoint is admin-only, never allow a single
    // charge beyond a sane maximum, so a bug or compromised session can't trigger a runaway charge.
    // Cap is the greater of $5,000 or 3x the computed default for this session, whichever is higher.
    const MAX_CENTS = Math.max(500000, defaultAmountCents * 3);
    if (amountCents > MAX_CENTS) {
      return res.status(400).json({ error: 'That charge amount looks too high — please double-check and try again.' });
    }

    const paymentMethods = await stripe.paymentMethods.list({
      customer: booking.stripeCustomerId,
      type: 'card'
    });
    if (paymentMethods.data.length === 0) {
      return res.status(400).json({ error: 'No saved card found for this customer' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: booking.stripeCustomerId,
      payment_method: paymentMethods.data[0].id,
      off_session: true,
      confirm: true,
      receipt_email: booking.clientEmail,
      description: `Clarity session, ${mins} min, ${booking.date}`
    }, {
      // Idempotency key tied to booking + amount + the specific card: an accidental double-submit
      // (same card, same amount) can never double-charge, but if a charge is declined and the
      // client saves a NEW card, the key changes and the retry genuinely attempts the new card
      // instead of replaying Stripe's cached decline from the old one.
      idempotencyKey: `charge-${booking.id}-${amountCents}-${paymentMethods.data[0].id}`
    });

    booking.status = 'charged';
    booking.amount = amountCents / 100;
    booking.actualMinutes = mins;
    booking.stripePaymentIntentId = paymentIntent.id;

    await kv.set('app-data', data);

    try {
      const receipt = receiptEmail(booking);
      await sendEmail({ to: booking.clientEmail, subject: receipt.subject, html: receipt.html });
    } catch (e) { /* email is best-effort */ }

    res.status(200).json({ ok: true, amount: amountCents / 100 });
  } catch (err) {
    console.error('Charge error:', err);
    // Surface Stripe's card-decline reason (safe, user-facing) but nothing internal.
    if (err && err.type === 'StripeCardError') {
      return res.status(402).json({ error: 'The card was declined.' });
    }
    res.status(500).json({ error: 'Something went wrong processing the charge. Please try again.' });
  }
}
