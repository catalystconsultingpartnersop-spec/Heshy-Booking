import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import { verifyAdminToken, randomToken } from './_lib/auth.js';

export const maxDuration = 30;

function defaultState() {
  return {
    bookings: [],
    clients: [],
    overrides: [],
    settings: { meetLink: '', location: '', durationOptions: [60], intakeQuestions: [] },
    availability: { virtual: [], 'in-person': [] }
  };
}

function dowOf(dateStr) { const [y, mo, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }

// Resolves which address applies for a given date, for in-person only — matches the same logic
// used at original booking time in create-booking.js, so a reschedule to a different day (or a
// different format) correctly picks up that day's own location.
function resolveAddress(data, date) {
  const override = (data.overrides || []).find(o => o.date === date && o.type === 'in-person' && o.address);
  if (override) return override.address;
  const weekday = dowOf(date);
  const rule = (data.availability?.['in-person'] || []).find(r => r.days.includes(weekday) && r.address);
  if (rule) return rule.address;
  return data.settings?.location || '';
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

async function handleCleanupLargePdfs(req, res) {
  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });
  const target = (data.clients || []).find(c => c.wgPdfData && c.wgPdfData.startsWith('data:'));
  if (!target) return res.status(200).json({ ok: true, migrated: null, remaining: 0 });
  let status;
  try {
    const base64 = target.wgPdfData.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    const safeName = (target.wgPdfName || 'working-genius.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put('wg-pdfs/' + Date.now() + '-' + safeName, buffer, { access: 'public', contentType: 'application/pdf' });
    target.wgPdfData = blob.url;
    status = 'migrated to Blob storage';
  } catch (e) {
    target.wgPdfData = '';
    status = 'could not migrate, PDF removed (re-upload manually): ' + e.message;
  }
  await kv.set('app-data', data);
  const remaining = (data.clients || []).filter(c => c.wgPdfData && c.wgPdfData.startsWith('data:')).length;
  res.status(200).json({ ok: true, migrated: { client: target.name, status }, remaining });
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
  const { bookingId, newDate, newTime, newType } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });
  if (!newDate || !newTime) return res.status(400).json({ error: 'Provide newDate and newTime.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });

  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const targetDate = newDate, targetTime = newTime, targetDuration = booking.durationMin;
  const targetType = (newType === 'virtual' || newType === 'in-person') ? newType : booking.type;
  const targetLocation = targetType === 'in-person' ? resolveAddress(data, targetDate) : '';

  if (booking.calendarEventId) {
    try {
      const accessToken = await getGoogleAccessToken();
      if (accessToken) {
        const endAt = addMinutes(targetDate, targetTime, targetDuration);
        const patchBody = {
          start: { dateTime: targetDate + 'T' + targetTime + ':00', timeZone: APP_TIMEZONE },
          end: { dateTime: endAt.date + 'T' + endAt.time + ':00', timeZone: APP_TIMEZONE },
          location: targetLocation
        };
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
  booking.type = targetType;
  booking.location = targetLocation;

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
    if (req.method === 'POST' && req.body && req.body.action === 'cleanup-large-pdfs') {
      return handleCleanupLargePdfs(req, res);
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
