import { kv } from '@vercel/kv';
import Stripe from 'stripe';
import { randomToken } from './_lib/auth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function getGoogleAccessToken() {
  const refreshToken = await kv.get('google-refresh-token');
  if (!refreshToken) return null;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const d = await r.json();
  return d.access_token || null;
}

function normalizePhone(p) {
  return (p || '').replace(/\D/g, '');
}

function clientSummary(client, bookings, settings) {
  const clientBookings = bookings.filter(b => b.clientId === client.id);
  const cutoffHours = (settings?.clientCancelCutoffHours != null) ? settings.clientCancelCutoffHours : 3;
  const cutoff = new Date(Date.now() + cutoffHours * 60 * 60 * 1000);
  // Upcoming: not cancelled, not already charged.
  const upcoming = clientBookings
    .filter(b => !b.cancelled && b.status !== 'charged')
    .map(b => ({
      id: b.id, date: b.date, time: b.time, type: b.type,
      cancellable: new Date(b.date + 'T' + b.time + ':00') >= cutoff
    }));
  // Past/history: any session that was actually charged stays visible here regardless of
  // whether it was later cancelled (e.g. cancelled afterward just to free up the original slot)
  // — the client was billed for it, so they should always be able to see it.
  const past = clientBookings
    .filter(b => b.status === 'charged')
    .map(b => ({
      date: b.date, actualMinutes: b.actualMinutes, durationMin: b.durationMin,
      type: b.type, amount: b.amount, clientSummary: b.clientSummary
    }));
  return { found: true, name: client.name, phone: client.phone, email: client.email, upcoming, past, hasCard: !!client.stripeCustomerId, cancelCutoffHours: cutoffHours };
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

  const summary = clientSummary(client, data.bookings || [], data.settings);
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

  res.status(200).json(clientSummary(client, data.bookings || [], data.settings));
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
    console.error('Server error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

async function handleCancelBooking(req, res) {
  const { token, bookingId } = req.body || {};
  if (!token || !bookingId) return res.status(400).json({ error: 'Missing token or bookingId.' });
  const clientId = await kv.get('portal-session:' + token);
  if (!clientId) return res.status(401).json({ error: 'Your session has expired — please log in again.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found.' });
  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Session not found.' });
  if (booking.clientId !== clientId) return res.status(403).json({ error: 'This session does not belong to you.' });
  if (booking.cancelled) return res.status(400).json({ error: 'This session is already cancelled.' });
  if (booking.status === 'charged') return res.status(400).json({ error: 'This session has already been charged — please contact Heshy directly.' });

  // The real, authoritative cutoff check — never trust the client's own view of whether it's
  // still cancellable, since that display could be stale by the time they click.
  const cutoffHours = (data.settings?.clientCancelCutoffHours != null) ? data.settings.clientCancelCutoffHours : 3;
  const cutoff = new Date(Date.now() + cutoffHours * 60 * 60 * 1000);
  const sessionDateTime = new Date(booking.date + 'T' + booking.time + ':00');
  if (sessionDateTime < cutoff) {
    return res.status(400).json({ error: `Sessions can only be cancelled online at least ${cutoffHours} hours in advance. Please contact Heshy directly for shorter notice.` });
  }

  // Delete the linked Calendar event so the time actually frees up, same as an admin cancel.
  if (booking.calendarEventId) {
    try {
      const accessToken = await getGoogleAccessToken();
      if (accessToken) {
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}?sendUpdates=all`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` }
        });
      }
    } catch (e) { /* best-effort — the booking is still marked cancelled below either way */ }
  }

  booking.cancelled = true;
  await kv.set('app-data', data);
  res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  try {
    // Backward-compatible plain GET-by-email is intentionally removed — every path now requires
    // the phone match (login) or a valid session token, closing the "just an email" exposure.
    if (req.method === 'POST' && req.body?.action === 'login') return handleLogin(req, res);
    if (req.body?.action === 'session' || req.query?.action === 'session') return handleSession(req, res);
    if (req.method === 'POST' && req.body?.action === 'confirm-card-update') return handleConfirmCardUpdate(req, res);
    if (req.method === 'POST' && req.body?.action === 'cancel-booking') return handleCancelBooking(req, res);
    res.status(400).json({ error: 'Unknown or missing action.' });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
