import { kv } from '@vercel/kv';
import { randomInt, timingSafeEqual } from 'crypto';
import { randomToken, redeemScopedToken } from './_lib/auth.js';
import { limited } from './_lib/limits.js';
import { score, validAnswers, profileOf } from './_lib/assessment.js';
import { sendEmail, cancellationEmail, clientCancelledAlertEmail, portalCodeEmail } from './_lib/email.js';
import { mutate, SKIP_WRITE } from './_lib/store.js';
import { logError } from './_lib/errorlog.js';
import { stripe, resolveCustomer, setDefaultCard } from './_lib/stripecustomer.js';

const PORTAL_SESSION_SECONDS = 60 * 60 * 24 * 14; // 14 days

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
  const profile = profileOf(client.strengths?.letters || client.wgLetters || '');
  return { found: true, name: client.name, phone: client.phone, email: client.email, upcoming, past,
           hasCard: !!client.stripeCustomerId, cancelCutoffHours: cutoffHours,
           strengths: profile.complete ? { letters: profile.letters } : null };
}

// Signing in to the portal.
//
// It used to be email plus phone number. Both are findable — a phone number is on signatures,
// websites, shared contacts and data brokers — so anyone holding them could read a client's
// session history and cancel their appointments. A per-email attempt limit slowed guessing but
// did nothing for a client whose details were already known.
//
// Now the email only decides where a code is sent. Possession of that inbox is what proves who
// they are, which is the same standard the confirmation emails already rely on.

const CODE_TTL_SECONDS = 60 * 10;   // ten minutes
const CODE_MAX_ATTEMPTS = 5;

function sixDigitCode() {
  // Uniform across 000000-999999, from the operating system's random source. Math.random would
  // be predictable, and a modulo of a small random range would skew the distribution.
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

async function handleRequestCode(req, res) {
  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Please enter your email address.' });

  // Rate-limited per caller and per address, so this can't be used to mail-bomb someone or to
  // work out who is a client.
  if (await limited(req, res, 'portal-code', 10, 3600)) return;
  const perEmail = 'portal-code-sent:' + email;
  const sentCount = Number(await kv.get(perEmail)) || 0;
  if (sentCount >= 5) {
    return res.status(200).json({ ok: true });   // same answer either way
  }
  await kv.set(perEmail, sentCount + 1, { ex: 900 });

  const data = await kv.get('app-data');
  const client = (data?.clients || []).find(c => (c.email || '').toLowerCase().trim() === email);

  // A code is only ever sent to a real client, but the response never reveals whether one
  // exists. Saying "no such client" would turn this into a way to test email addresses.
  if (client && !client.blocked) {
    const code = sixDigitCode();
    await kv.set('portal-code:' + email, { code, clientId: client.id, attempts: 0 }, { ex: CODE_TTL_SECONDS });
    try {
      const mail = portalCodeEmail(client, code);
      await sendEmail({ to: client.email, subject: mail.subject, html: mail.html });
    } catch (e) {
      await logError('portal-request-code', e, { email });
    }
  }
  return res.status(200).json({ ok: true });
}

async function handleVerifyCode(req, res) {
  const email = (req.body?.email || '').toLowerCase().trim();
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (!email || !code) return res.status(400).json({ error: 'Please enter the code from your email.' });

  const key = 'portal-code:' + email;
  const record = await kv.get(key);
  if (!record) return res.status(400).json({ error: 'That code has expired. Please ask for a new one.' });

  if ((record.attempts || 0) >= CODE_MAX_ATTEMPTS) {
    await kv.del(key);
    return res.status(429).json({ error: 'Too many tries. Please ask for a new code.' });
  }

  // Constant-time, so the comparison itself gives nothing away.
  const a = Buffer.from(String(record.code));
  const b = Buffer.from(code);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    await kv.set(key, { ...record, attempts: (record.attempts || 0) + 1 }, { ex: CODE_TTL_SECONDS });
    return res.status(400).json({ error: "That code doesn't match. Please check and try again." });
  }

  // One use only.
  await kv.del(key);
  await kv.del('portal-code-sent:' + email);

  const data = await kv.get('app-data');
  const client = (data?.clients || []).find(c => c.id === record.clientId);
  if (!client || client.blocked) return res.status(400).json({ error: 'We could not find your details.' });

  const token = randomToken();
  // A portal session shows a client's history and can cancel their sessions, and it lives in
  // browser storage on whatever device they used — often a shared one.
  await kv.set('portal-session:' + token, client.id, { ex: PORTAL_SESSION_SECONDS });

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

async function handleSaveStrengths(req, res) {
  const { token, strengthsToken, answers } = req.body || {};

  let clientId = null;
  if (token) clientId = await kv.get('portal-session:' + token);
  if (!clientId && strengthsToken) clientId = await redeemScopedToken('strengths-invite', strengthsToken);
  if (!clientId) return res.status(401).json({ error: 'This link has expired. You can sign in to your portal to finish it.' });

  if (!validAnswers(answers)) return res.status(400).json({ error: 'Those answers look incomplete. Please finish the assessment and try again.' });

  const result = score(answers);
  let missing = false;
  await mutate(data => {
    const client = (data.clients || []).find(c => c.id === clientId);
    if (!client) { missing = true; return SKIP_WRITE; }
    client.strengths = {
      v: result.v,
      letters: result.letters,
      scores: result.scores,
      clear: result.clear,
      takenAt: Date.now(),
      source: 'assessment'
    };
    // The old Working Genius letters field is what Manage has always read. Keep it in step so
    // nothing that displays it has to care which of the two produced the result.
    client.wgLetters = result.letters;
  });
  if (missing) return res.status(404).json({ error: 'We could not find your details.' });

  return res.status(200).json({ ok: true, result: { letters: result.letters, clear: result.clear } });
}

// Starting a card replacement from the portal.
//
// This step didn't exist. The page asked create-setup-intent for a SetupIntent and passed it a
// customer id taken from the portal response — but the portal response never contained one (it
// returns only `hasCard`, deliberately, so a client's Stripe id isn't handed to the browser).
// The id arrived undefined, so Stripe was asked to create a customer with no name, and every
// card replacement failed. The session itself identifies the client, so the SetupIntent is made
// here and only the client secret goes back.
async function handleStartCardUpdate(req, res) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing token.' });
  const clientId = await kv.get('portal-session:' + token);
  if (!clientId) return res.status(401).json({ error: 'Your session has expired — please log in again.' });

  const data = await kv.get('app-data');
  const client = (data?.clients || []).find(c => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'We could not find your details.' });

  try {
    const { customer } = await resolveCustomer(data, { name: client.name, email: client.email, phone: client.phone });
    if (client.stripeCustomerId !== customer.id) {
      await mutate(fresh => {
        const c = (fresh.clients || []).find(x => x.id === clientId);
        if (!c) return SKIP_WRITE;
        c.stripeCustomerId = customer.id;
      });
    }
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card']
    });
    res.status(200).json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error('Server error:', err);
    await logError('portal-lookup', err, { action: 'start-card-update' });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
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
    // A successful SetupIntent has normally attached the card already, in which case attaching
    // it again throws. That isn't a failure — carry on and make it the default.
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: client.stripeCustomerId });
    } catch (e) {
      const method = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (!method || method.customer !== client.stripeCustomerId) throw e;
    }
    await setDefaultCard(client.stripeCustomerId, paymentMethodId);

    // Make the new card apply to sessions they haven't been billed for yet. Older bookings can
    // still point at a separate Stripe customer from the days when each booking made its own,
    // and those would otherwise keep charging the card attached to that old customer.
    await mutate(fresh => {
      const c = (fresh.clients || []).find(x => x.id === clientId);
      if (!c) return SKIP_WRITE;
      let moved = 0;
      for (const b of (fresh.bookings || [])) {
        if (b.clientId !== c.id) continue;
        if (b.status === 'charged' || b.cancelled) continue;
        if (b.stripeCustomerId !== c.stripeCustomerId) { b.stripeCustomerId = c.stripeCustomerId; moved++; }
      }
      if (!moved) return SKIP_WRITE;
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Server error:', err);
    await logError('portal-lookup', err, { method: req.method, action: req.body?.action || req.query?.action });
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

  await mutate(fresh => {
    const b = (fresh.bookings || []).find(x => x.id === booking.id);
    if (!b) return SKIP_WRITE;
    b.cancelled = true;
    b.cancelledAt = Date.now();
    b.cancelledBy = 'client';
  });

  // Confirm it to the client, and tell Heshy — a client could cancel and he would only find
  // out by happening to look at Manage.
  try {
    const mail = cancellationEmail(booking, data.settings || {}, { by: 'client' });
    if (booking.clientEmail) await sendEmail({ to: booking.clientEmail, subject: mail.subject, html: mail.html });
    const alert = clientCancelledAlertEmail(booking);
    await sendEmail({ to: 'heshy@catalystconsultingnyc.com', subject: alert.subject, html: alert.html });
  } catch (e) {
    await logError('portal-cancel-email', e, { bookingId: booking.id });
  }

  res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  try {
    // Backward-compatible plain GET-by-email is intentionally removed — every path now requires
    // the phone match (login) or a valid session token, closing the "just an email" exposure.
    if (req.method === 'POST' && req.body?.action === 'request-code') return handleRequestCode(req, res);
    if (req.method === 'POST' && req.body?.action === 'verify-code') return handleVerifyCode(req, res);
    if (req.method === 'POST' && req.body?.action === 'logout') {
      // Logging out used to clear the browser's copy only; the server token stayed valid for
      // the rest of its life, so a copied link or a shared device still worked.
      const t = req.body.token;
      if (t) await kv.del('portal-session:' + t);
      return res.status(200).json({ ok: true });
    }
    if (req.body?.action === 'session' || req.query?.action === 'session') return handleSession(req, res);
    if (req.method === 'POST' && req.body?.action === 'save-strengths') return handleSaveStrengths(req, res);
    if (req.method === 'POST' && req.body?.action === 'start-card-update') return handleStartCardUpdate(req, res);
    if (req.method === 'POST' && req.body?.action === 'confirm-card-update') return handleConfirmCardUpdate(req, res);
    if (req.method === 'POST' && req.body?.action === 'cancel-booking') return handleCancelBooking(req, res);
    res.status(400).json({ error: 'Unknown or missing action.' });
  } catch (err) {
    console.error('Server error:', err);
    await logError('portal-lookup', err, { method: req.method, action: req.body?.action || req.query?.action });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
