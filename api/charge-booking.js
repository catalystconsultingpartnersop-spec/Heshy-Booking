import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import { verifyAdminToken } from './_lib/auth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { bookingId, amount } = req.body;
    const data = await kv.get('app-data');
    if (!data) return res.status(404).json({ error: 'No data found' });

    const booking = data.bookings.find(b => b.id === bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.stripeCustomerId) return res.status(400).json({ error: 'No card on file for this booking' });

    const mins = booking.actualMinutes || booking.durationMin;
    const defaultAmountCents = Math.round((mins / 60) * 500 * 100);
    const amountCents = (typeof amount === 'number' && !isNaN(amount) && amount >= 0)
      ? Math.round(amount * 100)
      : defaultAmountCents;

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
    });

    booking.status = 'charged';
    booking.amount = amountCents / 100;
    booking.actualMinutes = mins;
    booking.stripePaymentIntentId = paymentIntent.id;

    await kv.set('app-data', data);
    res.status(200).json({ ok: true, amount: amountCents / 100 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
