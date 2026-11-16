import { kv } from '@vercel/kv';
import { logError } from './_lib/errorlog.js';
import { stripe, resolveCustomer, issueSetupToken } from './_lib/stripecustomer.js';
import { limited, checkBookingFields } from './_lib/limits.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // Every call here can create a Stripe customer, so it is the most expensive public endpoint
    // to leave open.
    if (await limited(req, res, 'setup-intent', 15, 3600)) return;
    const { name, email, phone } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    const tooBig = checkBookingFields({ name, email, phone });
    if (tooBig) return res.status(400).json({ error: tooBig });

    // The customer is resolved here, from the email, against our own client records — a
    // returning client reuses the customer they already have instead of collecting a new one
    // per booking. The browser no longer sends a customer id and no longer receives one back:
    // it gets a token that only create-booking can redeem, and only for this same email.
    const data = (await kv.get('app-data')) || { clients: [] };
    const { customer } = await resolveCustomer(data, { name, email, phone });

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card']
    });
    const setupToken = await issueSetupToken(customer.id, email);

    res.status(200).json({ clientSecret: setupIntent.client_secret, setupToken });
  } catch (err) {
    console.error('Server error:', err);
    await logError('create-setup-intent', err, { method: req.method, email: req.body?.email });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
