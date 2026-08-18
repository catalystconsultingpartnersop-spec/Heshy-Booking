import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import { sendEmail, bookingConfirmationEmail, newBookingAlertEmail } from './_lib/email.js';

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

const APP_TIMEZONE = 'America/New_York';

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

// Authoritative check: is [time, time+durationMin) fully inside an open window on this date/type,
// after subtracting every other booking of the same type and (if available) real Calendar busy time?
// This is the actual security boundary — the client-side UI computation is just for showing good options.
function isRangeAvailable(data, date, time, durationMin, type, excludeBookingId, calendarBusyRanges) {
  const weekday = dowOf(date);
  const windows = [];
  (data.availability?.[type] || []).filter(r => r.days.includes(weekday)).forEach(r => windows.push([timeToMin(r.start), timeToMin(r.end)]));
  (data.overrides || []).filter(o => o.date === date && o.type === type).forEach(o => windows.push([timeToMin(o.start), timeToMin(o.end)]));
  if (windows.length === 0) return false;

  const reqStart = timeToMin(time), reqEnd = reqStart + durationMin;
  const fitsAWindow = windows.some(([ws, we]) => reqStart >= ws && reqEnd <= we);
  if (!fitsAWindow) return false;

  const conflicts = (data.bookings || [])
    .filter(b => b.id !== excludeBookingId && b.date === date && b.type === type)
    .some(b => {
      const bs = timeToMin(b.time), be = bs + (b.durationMin || 60);
      return reqStart < be && reqEnd > bs;
    });
  if (conflicts) return false;

  if (calendarBusyRanges) {
    const busyConflict = calendarBusyRanges.some(([bs, be]) => reqStart < be && reqEnd > bs);
    if (busyConflict) return false;
  }
  return true;
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { date, time, durationMin, type, name, email, phone, intakeAnswers, wgPdfName, wgPdfData, stripeCustomerId, couponCode } = req.body || {};
    if (!date || !time || !durationMin || !type || !name || !email || !phone || !stripeCustomerId) {
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
    // an arbitrary length.
    const allowedDurations = (data.settings?.durationOptions && data.settings.durationOptions.length) ? data.settings.durationOptions : [60];
    if (!allowedDurations.includes(Number(durationMin))) {
      return res.status(400).json({ error: 'That session length is not offered.' });
    }

    // Re-check real Google Calendar busy time at the moment of booking (best-effort — if Calendar
    // isn't connected or the check fails, we don't block the booking on it, matching how the rest
    // of the app treats Calendar as a helpful-but-not-required integration).
    let calendarBusyRanges = null;
    try {
      const accessTokenForCheck = await getGoogleAccessToken();
      if (accessTokenForCheck) {
        const dayStart = new Date(date + 'T00:00:00');
        const dayEnd = new Date(date + 'T23:59:59');
        const fbRes = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessTokenForCheck}` },
          body: JSON.stringify({ timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), items: [{ id: 'primary' }] })
        });
        const fbData = await fbRes.json();
        const busy = fbData.calendars?.primary?.busy || [];
        calendarBusyRanges = busy.map(b => {
          const bs = new Date(b.start), be = new Date(b.end);
          return [Math.max(0, Math.round((bs - dayStart) / 60000)), Math.min(24 * 60, Math.round((be - dayStart) / 60000))];
        });
      }
    } catch (e) { /* best-effort; skip if it fails */ }

    if (!isRangeAvailable(data, date, time, Number(durationMin), type, null, calendarBusyRanges)) {
      return res.status(400).json({ error: 'That time was just booked or is no longer available. Please pick another time.' });
    }

    let client = data.clients.find(c => c.email.toLowerCase() === email.toLowerCase());
    if (client && client.blocked) {
      return res.status(403).json({ error: 'Unable to book at this time.' });
    }
    if (!client) {
      let storedWgPdfData = '';
      if (wgPdfData && wgPdfName) {
        try {
          const base64 = wgPdfData.split(',')[1];
          const buffer = Buffer.from(base64, 'base64');
          const safeName = wgPdfName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const blob = await put('wg-pdfs/' + Date.now() + '-' + safeName, buffer, { access: 'public', contentType: 'application/pdf' });
          storedWgPdfData = blob.url;
        } catch (e) { /* if upload fails, just skip storing the PDF rather than blocking the booking */ }
      }
      client = {
        id: uid(), name, email, phone,
        intakeAnswers: intakeAnswers || [], wgPdfName: wgPdfName || '', wgPdfData: storedWgPdfData,
        blocked: false, createdAt: Date.now()
      };
      data.clients.push(client);
    }

    let comped = false;
    let appliedCoupon = null;
    if (couponCode) {
      const trimmed = String(couponCode).trim().toUpperCase();
      const coupon = (data.settings?.coupons || []).find(c => c.code === trimmed);
      if (coupon && (coupon.maxUses == null || (coupon.usedCount || 0) < coupon.maxUses)) {
        comped = true;
        appliedCoupon = coupon;
      }
    }

    const resolvedAddress = type === 'in-person' ? resolveAddress(data, date) : '';

    const booking = {
      id: uid(), slotId: null, date, time,
      durationMin: Number(durationMin), type,
      clientId: client.id, clientName: name, clientEmail: email, clientPhone: phone,
      stripeCustomerId, status: 'scheduled', comped, couponCode: comped ? appliedCoupon.code : '',
      meetLink: '', location: resolvedAddress, summary: '', clientSummary: '', actualMinutes: null, amount: null, createdAt: Date.now()
    };
    data.bookings.push(booking);
    if (comped) {
      appliedCoupon.usedCount = (appliedCoupon.usedCount || 0) + 1;
    }

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
                requestId: booking.id,
                conferenceSolutionKey: { type: 'hangoutsMeet' }
              }
            }
          })
        });
        const evData = await evRes.json();
        if (evData.hangoutLink) {
          booking.meetLink = evData.hangoutLink;
        }
        if (evData.id) {
          booking.calendarEventId = evData.id;
        }
      }
    } catch (e) { /* calendar sync is best-effort */ }

    await kv.set('app-data', data);

    try {
      const confirmation = bookingConfirmationEmail(booking, data.settings || {});
      await sendEmail({ to: booking.clientEmail, subject: confirmation.subject, html: confirmation.html });
      const alert = newBookingAlertEmail(booking, data.settings || {}, client);
      await sendEmail({ to: 'heshy@catalystconsultingnyc.com', subject: alert.subject, html: alert.html });
    } catch (e) { /* email is best-effort */ }

    res.status(200).json({ ok: true, bookingId: booking.id, meetLink: type === 'virtual' ? booking.meetLink : undefined, location: type === 'in-person' ? resolvedAddress : undefined, comped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
