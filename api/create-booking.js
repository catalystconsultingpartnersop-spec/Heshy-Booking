import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import { sendEmail, bookingConfirmationEmail, newBookingAlertEmail } from './_lib/email.js';
import { APP_TIMEZONE, busyRangesForDate, etDayBounds } from './_lib/time.js';
import { isRangeAvailable } from './_lib/availability.js';
import { logError } from './_lib/errorlog.js';
import { redeemSetupToken } from './_lib/stripecustomer.js';
import { issueScopedToken } from './_lib/auth.js';
import { mutate, SKIP_WRITE } from './_lib/store.js';

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

// Shared by both the live coupon check and the actual booking submission, so they always agree.
function validateCoupon(data, code, email) {
  if (!code) return { valid: false, reason: null };
  const trimmed = String(code).trim().toUpperCase();
  const coupon = (data.settings?.coupons || []).find(c => c.code === trimmed);
  if (!coupon) return { valid: false, reason: "That code wasn't found." };
  if (coupon.maxUses != null && (coupon.usedCount || 0) >= coupon.maxUses) {
    return { valid: false, reason: 'That code has reached its usage limit.' };
  }
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail && (coupon.usedByEmails || []).includes(normalizedEmail)) {
    return { valid: false, reason: "You've already used this code." };
  }
  return { valid: true, coupon };
}

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToTime(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function dowOf(dateStr) { const [y, mo, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }

// Resolves which address applies for a given date, for in-person only: a one-off override for that
// exact date takes priority over the matching recurring weekly rule (e.g. Mon-Thu one office,
// Friday another). Falls back to the global settings.location if neither has an address set.
function resolveAddress(data, date) {
  const override = (data.overrides || []).find(o => o.date === date && o.type === 'in-person' && o.address);
  if (override) return override.address;
  const weekday = dowOf(date);
  const rule = (data.availability?.['in-person'] || []).find(r => r.days.includes(weekday) && r.address);
  if (rule) return rule.address;
  return data.settings?.location || '';
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// Compute date/time after adding minutes, using UTC arithmetic purely as scratch
// math (never converted to a real timezone) so it's deterministic regardless of
// what timezone the server process happens to run in.
function addMinutes(dateStr, timeStr, minutesToAdd) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  dt.setUTCMinutes(dt.getUTCMinutes() + minutesToAdd);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()),
    time: pad(dt.getUTCHours()) + ':' + pad(dt.getUTCMinutes())
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query?.action === 'check-coupon') {
    try {
      const data = await kv.get('app-data');
      const result = validateCoupon(data || {}, req.query.code, req.query.email);
      return res.status(200).json({
        valid: result.valid,
        reason: result.reason || null,
        discountType: result.valid ? (result.coupon.discountType || 'free') : null,
        discountValue: result.valid ? result.coupon.discountValue : null
      });
    } catch (err) {
      return res.status(500).json({ valid: false, reason: 'Could not check that code right now.' });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { date, time, durationMin, type, name, email, phone, intakeAnswers, wgPdfName, wgPdfData, setupToken, couponCode } = req.body || {};
    if (!date || !time || !durationMin || !type || !name || !email || !phone || !setupToken) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (type !== 'virtual' && type !== 'in-person') {
      return res.status(400).json({ error: 'Invalid session type.' });
    }

    const data = await kv.get('app-data');
    if (!data) return res.status(400).json({ error: 'No data found.' });
    if (!data.clients) data.clients = [];
    if (!data.bookings) data.bookings = [];

    // Reject a past date/time outright.
    const now = new Date();
    const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    if (date < todayStr) return res.status(400).json({ error: 'That date has already passed.' });
    if (date === todayStr) {
      const nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      if (time <= nowTime) return res.status(400).json({ error: 'That time has already passed.' });
    }

    // Only allow durations you've actually configured as offered, so a crafted request can't book
    // an arbitrary length. Quick Check-in (15 min) is always allowed separately from this list,
    // since it's a standing option regardless of which standard durations are toggled on.
    const configuredDurations = (data.settings?.durationOptions && data.settings.durationOptions.length) ? data.settings.durationOptions : [60];
    const allowedDurations = [15, ...configuredDurations];
    if (!allowedDurations.includes(Number(durationMin))) {
      return res.status(400).json({ error: 'That session length is not offered.' });
    }

    // Quick Check-in is described to clients as a 15-minute phone call for people who have
    // worked with Heshy before. The server accepted 15 minutes from anyone, in either format,
    // so switching to "In person" after picking Quick Check-in produced a combination that
    // isn't actually offered.
    if (Number(durationMin) === 15) {
      if (type !== 'virtual') {
        return res.status(400).json({ error: 'Quick Check-in is a phone call — please pick a standard session length for an in-person meeting.' });
      }
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const returning = (data.clients || []).some(c => (c.email || '').trim().toLowerCase() === normalizedEmail);
      if (!returning) {
        return res.status(400).json({ error: 'Quick Check-in is for clients who have worked with Heshy before. Please pick a standard session length for a first session.' });
      }
    }

    // Re-check real Google Calendar busy time at the moment of booking (best-effort — if Calendar
    // isn't connected or the check fails, we don't block the booking on it, matching how the rest
    // of the app treats Calendar as a helpful-but-not-required integration).
    let calendarBusyRanges = null;
    try {
      const accessTokenForCheck = await getGoogleAccessToken();
      if (accessTokenForCheck) {
        // Query the Eastern calendar day, not the UTC one — otherwise the window is shifted by
        // 4-5 hours and misses part of the real day.
        const bounds = etDayBounds(date);
        const fbRes = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessTokenForCheck}` },
          body: JSON.stringify({ timeMin: bounds.start.toISOString(), timeMax: bounds.end.toISOString(), items: [{ id: 'primary' }] })
        });
        const fbData = await fbRes.json();
        // Convert each busy interval to Eastern wall-clock minutes — the same scale the rest of
        // this file measures times on. Subtracting raw UTC instants here was reading an 11am
        // meeting as 4pm, so the conflict check was looking at the wrong part of the day.
        calendarBusyRanges = busyRangesForDate(fbData.calendars?.primary?.busy || [], date);
      }
    } catch (e) { /* best-effort; skip if it fails */ }

    if (!isRangeAvailable(data, date, time, Number(durationMin), type, null, calendarBusyRanges)) {
      return res.status(400).json({ error: 'That time was just booked or is no longer available. Please pick another time.' });
    }

    const blockedClient = data.clients.find(c => c.email.toLowerCase() === email.toLowerCase());
    if (blockedClient && blockedClient.blocked) {
      return res.status(403).json({ error: 'Unable to book at this time.' });
    }

    // Which Stripe customer this booking belongs to is decided by the token issued when the card
    // was saved, not by anything the browser claims. The token is only valid for the same email
    // it was issued for, so a caller can't attach their booking to someone else's customer.
    const stripeCustomerId = await redeemSetupToken(setupToken, email);
    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'Your payment details expired before the booking finished. Please re-enter your card and try again.' });
    }

    // Upload the WG PDF now (independent of the shared data blob, so no race risk here) — but
    // hold off on touching data.clients/data.bookings until right before the final write below.
    let storedWgPdfData = '';
    if (!blockedClient && wgPdfData && wgPdfName) {
      try {
        const base64 = wgPdfData.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        const safeName = wgPdfName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const blob = await put('wg-pdfs/' + Date.now() + '-' + safeName, buffer, { access: 'public', contentType: 'application/pdf' });
        storedWgPdfData = blob.url;
      } catch (e) { /* if upload fails, just skip storing the PDF rather than blocking the booking */ }
    }

    const resolvedAddress = type === 'in-person' ? resolveAddress(data, date) : '';
    const bookingId = uid();
    let meetLink = '';
    let calendarEventId = null;

    try {
      const accessToken = await getGoogleAccessToken();
      if (accessToken) {
        const endAt = addMinutes(date, time, Number(durationMin));
        const evRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            summary: 'Clarity session — ' + name,
            location: resolvedAddress,
            start: { dateTime: date + 'T' + time + ':00', timeZone: APP_TIMEZONE },
            end: { dateTime: endAt.date + 'T' + endAt.time + ':00', timeZone: APP_TIMEZONE },
            attendees: [{ email }],
            conferenceData: {
              createRequest: {
                requestId: bookingId,
                conferenceSolutionKey: { type: 'hangoutsMeet' }
              }
            }
          })
        });
        const evData = await evRes.json();
        if (evData.hangoutLink) meetLink = evData.hangoutLink;
        if (evData.id) calendarEventId = evData.id;
      }
    } catch (e) { /* calendar sync is best-effort */ }

    // Everything from here to the save runs under a lock, reading the record fresh inside it.
    // Before, this was a plain read-modify-write: a client booking at the same moment Heshy saved
    // in Manage could erase his changes, or his save could erase the booking, with no warning.
    let failure = null, booking = null, client = null, comped = false, couponDiscount = null;
    let settingsSnapshot = {};
    try {
      await mutate(async (freshData) => {
      // Re-fetch the freshest possible data right before committing — everything above this point
      // (Calendar checks, event creation) can take several seconds, during which something else
      // could have changed the shared data. Re-reading here shrinks that risk window down to just
      // this final read-then-write, instead of the whole request's duration.
      if (!freshData.clients) freshData.clients = [];
      if (!freshData.bookings) freshData.bookings = [];

      if (!isRangeAvailable(freshData, date, time, Number(durationMin), type, null, calendarBusyRanges)) {
        failure = { status: 400, body: { error: 'That time was just booked or is no longer available. Please pick another time.' } };
          return SKIP_WRITE;
      }

      client = freshData.clients.find(c => c.email.toLowerCase() === email.toLowerCase());
      if (client && client.blocked) {
        failure = { status: 403, body: { error: 'Unable to book at this time.' } };
          return SKIP_WRITE;
      }
      if (!client) {
        client = {
          id: uid(), name, email, phone,
          intakeAnswers: intakeAnswers || [], wgPdfName: wgPdfName || '', wgPdfData: storedWgPdfData,
          blocked: false, createdAt: Date.now(), stripeCustomerId
        };
        freshData.clients.push(client);
      }
      // Keep name/phone current for a returning client too — otherwise a stale or mistaken value
      // from an earlier booking stays stuck forever, even though every later booking has the
      // correct info right there. Email stays as the matching key and is never silently changed.
      client.name = name;
      client.phone = phone;
      // This used to split one person across several Stripe customers, because create-setup-intent
      // made a brand-new customer for every booking and this line pointed the client at the newest
      // one. The fix is upstream: resolveCustomer() reuses the customer they already have. So the
      // id carried by the token is already theirs, and assigning it here keeps the client record
      // and the booking in agreement — including when their old customer was deleted in Stripe and
      // had to be replaced, which would otherwise leave a dead id on the record forever.
      client.stripeCustomerId = stripeCustomerId;

      let appliedCoupon = null;
      if (couponCode) {
        const couponResult = validateCoupon(freshData, couponCode, email);
        if (!couponResult.valid) {
          // A code that was accepted while they were typing can be used up or removed by the time
          // they finish. This used to book them at full price without a word, so they'd believe a
          // discount applied and only find out when the bill arrived. Now the booking stops and
          // they decide: remove the code, or go ahead at full price.
          failure = { status: 409, body: {
            error: couponResult.reason || "That code is no longer valid.",
            couponRejected: true,
            couponCode: String(couponCode).trim().toUpperCase()
          } };
          return SKIP_WRITE;
        }
        appliedCoupon = couponResult.coupon;
        comped = appliedCoupon.discountType === 'free' || !appliedCoupon.discountType; // treat legacy coupons (no discountType set) as free, matching prior behavior
        couponDiscount = comped ? null : { type: appliedCoupon.discountType, value: appliedCoupon.discountValue };
      }

      booking = {
        id: bookingId, slotId: null, date, time,
        durationMin: Number(durationMin), type,
        clientId: client.id, clientName: name, clientEmail: email, clientPhone: phone,
        stripeCustomerId, status: 'scheduled', comped, couponCode: appliedCoupon ? appliedCoupon.code : '', couponDiscount,
        meetLink, location: resolvedAddress, summary: '', clientSummary: '', actualMinutes: null, amount: null, createdAt: Date.now()
      };
      if (calendarEventId) booking.calendarEventId = calendarEventId;
      freshData.bookings.push(booking);
      if (appliedCoupon) {
        appliedCoupon.usedCount = (appliedCoupon.usedCount || 0) + 1;
        if (!Array.isArray(appliedCoupon.usedByEmails)) appliedCoupon.usedByEmails = [];
        appliedCoupon.usedByEmails.push(String(email).trim().toLowerCase());
        // Permanent referral tag on the client themselves — stays even after this one discounted
        // booking, so later full-price bookings from the same client are still traceable back to
        // whoever referred them. First coupon they ever use wins; never overwritten afterward.
        if (!client.referralSource) client.referralSource = appliedCoupon.code;
      }

      settingsSnapshot = freshData.settings || {};

      }, { fallback: data });
    } catch (err) {
      if (err.code === 'LOCK_TIMEOUT') return res.status(503).json({ error: err.message });
      throw err;
    }
    if (failure) return res.status(failure.status).json(failure.body);

    try {
      const confirmation = bookingConfirmationEmail(booking, settingsSnapshot);
      await sendEmail({ to: booking.clientEmail, subject: confirmation.subject, html: confirmation.html });
      const alert = newBookingAlertEmail(booking, settingsSnapshot, client);
      await sendEmail({ to: 'heshy@catalystconsultingnyc.com', subject: alert.subject, html: alert.html });
    } catch (e) { /* email is best-effort */ }

    // A narrow, expiring token that names only this client record, so the confirmation screen
    // can offer the strengths assessment without asking them to sign in first. Best-effort: if
    // it can't be issued, the booking still succeeded and they can do it from their portal.
    let strengthsToken = null;
    if (!client.strengths && !client.wgLetters) {
      try { strengthsToken = await issueScopedToken('strengths-invite', client.id, 60 * 60 * 24 * 14); }
      catch (e) { /* the booking is what matters */ }
    }

    res.status(200).json({ ok: true, bookingId: booking.id, strengthsToken, meetLink: type === 'virtual' ? booking.meetLink : undefined, location: type === 'in-person' ? resolvedAddress : undefined, comped, couponCode: booking.couponCode, couponDiscount: booking.couponDiscount });
  } catch (err) {
    console.error('Server error:', err);
    await logError('create-booking', err, { method: req.method, action: req.body?.action || req.query?.action });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
