import { kv } from '@vercel/kv';
import Stripe from 'stripe';
import { randomToken } from './_lib/auth.js';

// Converts an Eastern-time wall-clock date+time into the true UTC instant (DST-aware).
// Vercel servers run UTC; naive parsing skews every time comparison by 4-5 hours.
function etToUtc(date, time) {
  const probe = new Date(date + 'T12:00:00Z');
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(probe).find(p => p.type === 'timeZoneName').value;
  const m = part.match(/GMT([+-]\d+)(?::(\d+))?/);
  const offH = parseInt(m[1], 10), offM = m[2] ? parseInt(m[2], 10) : 0;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - offH, mi - (offH < 0 ? -offM : offM)));
}


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
  // Upcoming means genuinely still ahead. This used to be "not cancelled and not charged",
  // with no reference to the date at all — so a session from weeks ago that was never charged,
  // or was marked complete instead of charged, sat under "Upcoming" in the client's portal
  // forever.
  const now = Date.now();
  const hasPassed = b => etToUtc(b.date, b.time).getTime() + ((b.durationMin || 60) * 60000) <= now;

  const upcoming = clientBookings
    .filter(b => !b.cancelled && b.status !== 'charged' && !hasPassed(b))
    .map(b => ({
      id: b.id, date: b.date, time: b.time, type: b.type,
      cancellable: etToUtc(b.date, b.time) >= cutoff
    }));
  // History: anything charged (even if cancelled afterwards — they were billed, so they should
  // always be able to see it), plus any session whose time has simply passed.
  const past = clientBookings
    .filter(b => b.status === 'charged' || (!b.cancelled && hasPassed(b)))
    .map(b => ({
      date: b.date, actualMinutes: b.actualMinutes, durationMin: b.durationMin,
      type: b.type, amount: b.amount, clientSummary: b.clientSummary,
      awaitingBilling: b.status !== 'charged'
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
  const sessionDateTime = etToUtc(booking.date, booking.time);
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
