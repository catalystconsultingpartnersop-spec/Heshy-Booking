import { kv } from '@vercel/kv';
import Stripe from 'stripe';
import { randomToken } from './_lib/auth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function normalizePhone(p) {
  return (p || '').replace(/\D/g, '');
}

function clientSummary(client, bookings) {
  const clientBookings = bookings.filter(b => b.clientId === client.id);
  // Upcoming: not cancelled, not already charged.
  const upcoming = clientBookings
    .filter(b => !b.cancelled && b.status !== 'charged')
    .map(b => ({ date: b.date, time: b.time, type: b.type }));
  // Past/history: any session that was actually charged stays visible here regardless of
  // whether it was later cancelled (e.g. cancelled afterward just to free up the original slot)
  // — the client was billed for it, so they should always be able to see it.
  const past = clientBookings
    .filter(b => b.status === 'charged')
    .map(b => ({
      date: b.date, actualMinutes: b.actualMinutes, durationMin: b.durationMin,
      type: b.type, amount: b.amount, clientSummary: b.clientSummary
    }));
  return { found: true, name: client.name, phone: client.phone, email: client.email, upcoming, past, hasCard: !!client.stripeCustomerId };
}

async function handleLogin(req, res) {
  const email = (req.body?.email || '').toLowerCase().trim();
  const phone = normalizePhone(req.body?.phone);
  if (!email || !phone) return res.status(400).json({ error: 'Email and phone are both required.' });

  // Basic brute-force protection: block further attempts against this email for a while
  // after a handful of wrong tries, rather than allowing unlimited guesses at a phone number.
  const failKey = 'portal-fail:' + email;
  const fails = (await kv.get(failKey)) || 0;
  if (fails >= 6) {
    return res.status(429).json({ error: 'Too many attempts. Please try again in a bit, or contact Heshy directly.' });
  }

  const data = await kv.get('app-data');
  const client = (data?.clients || []).find(c => c.email.toLowerCase() === email);
  const match = client && normalizePhone(client.phone) === phone && phone.length >= 7;

  if (!match) {
    await kv.set(failKey, fails + 1, { ex: 900 }); // resets after 15 minutes
    return res.status(200).json({ found: false });
  }
  await kv.del(failKey);

  const token = randomToken();
  await kv.set('portal-session:' + token, client.id, { ex: 60 * 60 * 24 * 60 }); // 60 days

  const summary = clientSummary(client, data.bookings || []);
  res.status(200).json({ ...summary, token });
}

async function handleSession(req, res) {
  const token = req.body?.token || req.query?.token;
  if (!token) return res.status(400).json({ error: 'Missing token.' });
  const clientId = await kv.get('portal-session:' + token);
  if (!clientId) return res.status(200).json({ found: false, expired: true });

  const data = await kv.get('app-data');
  const client = (data?.clients || []).find(c => c.id === clientId);
  if (!client) return res.status(200).json({ found: false });

  res.status(200).json(clientSummary(client, data.bookings || []));
}

async function handleConfirmCardUpdate(req, res) {
  const { token, paymentMethodId } = req.body || {};
  if (!token || !paymentMethodId) return res.status(400).json({ error: 'Missing token or paymentMethodId.' });
  const clientId = await kv.get('portal-session:' + token);
  if (!clientId) return res.status(401).json({ error: 'Your session has expired — please log in again.' });

  const data = await kv.get('app-data');
  const client = (data?.clients || []).find(c => c.id === clientId);
  if (!client || !client.stripeCustomerId) return res.status(400).json({ error: 'No card on file to update.' });

  try {
    await stripe.paymentMethods.attach(paymentMethodId, { customer: client.stripeCustomerId });
    await stripe.customers.update(client.stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default async function handler(req, res) {
  try {
    // Backward-compatible plain GET-by-email is intentionally removed — every path now requires
    // the phone match (login) or a valid session token, closing the "just an email" exposure.
    if (req.method === 'POST' && req.body?.action === 'login') return handleLogin(req, res);
    if (req.body?.action === 'session' || req.query?.action === 'session') return handleSession(req, res);
    if (req.method === 'POST' && req.body?.action === 'confirm-card-update') return handleConfirmCardUpdate(req, res);
    res.status(400).json({ error: 'Unknown or missing action.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
