import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import { verifyAdminToken, randomToken } from './_lib/auth.js';

function defaultState() {
  return {
    slots: [],
    bookings: [],
    clients: [],
    settings: { meetLink: '', location: '', intakeQuestions: [] },
    availability: { virtual: [], 'in-person': [] }
  };
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
const APP_TIMEZONE = 'America/New_York';

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

async function handleUploadPdf(req, res) {
  const { fileName, fileDataUrl } = req.body || {};
  if (!fileName || !fileDataUrl) return res.status(400).json({ error: 'Missing fileName or fileDataUrl.' });
  try {
    const base64 = fileDataUrl.split(',')[1];
    if (!base64) return res.status(400).json({ error: 'Invalid file data.' });
    const buffer = Buffer.from(base64, 'base64');
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put('wg-pdfs/' + Date.now() + '-' + safeName, buffer, {
      access: 'public',
      contentType: 'application/pdf'
    });
    res.status(200).json({ ok: true, url: blob.url });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
}

async function handleCancelBooking(req, res) {
  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });

  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Delete the linked Google Calendar event so the time actually frees up —
  // otherwise Calendar still reports it busy even after the booking is gone.
  let calendarWarning = null;
  if (booking.calendarEventId) {
    try {
      const accessToken = await getGoogleAccessToken();
      if (accessToken) {
        const delRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}?sendUpdates=all`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!delRes.ok && delRes.status !== 410 && delRes.status !== 404) {
          calendarWarning = `Booking cancelled, but the calendar event could not be removed (status ${delRes.status}). You may need to delete it manually from Google Calendar.`;
        }
      } else {
        calendarWarning = 'Booking cancelled, but Google Calendar is not connected — the old calendar event was not removed.';
      }
    } catch (e) {
      calendarWarning = 'Booking cancelled, but removing the calendar event failed: ' + e.message;
    }
  }

  data.bookings = data.bookings.filter(b => b.id !== bookingId);
  await kv.set('app-data', data);
  res.status(200).json({ ok: true, warning: calendarWarning });
}

async function handleRescheduleBooking(req, res) {
  const { bookingId, newSlotId, newDate, newTime, newType } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });
  if (!newSlotId && !(newDate && newTime)) return res.status(400).json({ error: 'Provide either newSlotId or newDate + newTime.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });

  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  let targetDate, targetTime, targetDuration = booking.durationMin, targetSlotId = null;
  if (newSlotId) {
    const slot = (data.slots || []).find(s => s.id === newSlotId);
    if (!slot) return res.status(400).json({ error: 'That slot no longer exists.' });
    const alreadyTaken = (data.bookings || []).some(b => b.id !== bookingId && b.slotId === slot.id);
    if (alreadyTaken) return res.status(400).json({ error: 'That slot is already booked.' });
    targetDate = slot.date; targetTime = slot.time; targetDuration = slot.duration; targetSlotId = slot.id;
  } else {
    targetDate = newDate; targetTime = newTime;
  }
  const targetType = (newType === 'virtual' || newType === 'in-person') ? newType : booking.type;

  if (booking.calendarEventId) {
    try {
      const accessToken = await getGoogleAccessToken();
      if (accessToken) {
        const endAt = addMinutes(targetDate, targetTime, targetDuration);
        const patchBody = {
          start: { dateTime: targetDate + 'T' + targetTime + ':00', timeZone: APP_TIMEZONE },
          end: { dateTime: endAt.date + 'T' + endAt.time + ':00', timeZone: APP_TIMEZONE }
        };
        if (targetType !== booking.type) {
          patchBody.location = targetType === 'in-person' ? (data.settings?.location || '') : '';
        }
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}?sendUpdates=all`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(patchBody)
        });
      }
    } catch (e) { /* calendar sync is best-effort, don't block the reschedule */ }
  }

  booking.date = targetDate;
  booking.time = targetTime;
  booking.durationMin = targetDuration;
  booking.slotId = targetSlotId;
  booking.type = targetType;

  await kv.set('app-data', data);
  res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST' && req.body && req.body.action === 'login') {
      const { password } = req.body;
      if (!password || password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Incorrect password' });
      }
      const token = randomToken();
      await kv.set('admin-session:' + token, true);
      return res.status(200).json({ ok: true, token });
    }

    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'POST' && req.body && req.body.action === 'cancel-booking') {
      return handleCancelBooking(req, res);
    }
    if (req.method === 'POST' && req.body && req.body.action === 'reschedule-booking') {
      return handleRescheduleBooking(req, res);
    }
    if (req.method === 'POST' && req.body && req.body.action === 'upload-pdf') {
      return handleUploadPdf(req, res);
    }

    if (req.method === 'GET') {
      const data = (await kv.get('app-data')) || defaultState();
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      await kv.set('app-data', req.body);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
