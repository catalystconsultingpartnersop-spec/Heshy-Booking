import { kv } from '@vercel/kv';
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
        const delRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}`, {
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
        const startISO = new Date(targetDate + 'T' + targetTime + ':00').toISOString();
        const endISO = new Date(new Date(startISO).getTime() + targetDuration * 60000).toISOString();
        const patchBody = { start: { dateTime: startISO }, end: { dateTime: endISO } };
        if (targetType !== booking.type) {
          patchBody.location = targetType === 'in-person' ? (data.settings?.location || '') : '';
        }
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}`, {
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
