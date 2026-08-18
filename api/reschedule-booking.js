import { kv } from '@vercel/kv';
import { verifyAdminToken } from './_lib/auth.js';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    // newSlotId: move to one of the existing open slots (keeps that slot's date/time/duration/type).
    // Or pass newDate + newTime directly for a fully custom, ad-hoc time not tied to a pre-made slot
    // (e.g. "we ended up doing it earlier than planned") — durationMin/type default to the booking's own.
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

    // Move the linked Calendar event to the new time (keeps the same Meet link/event, just retimed)
    // rather than deleting and recreating it. Also update the location field if the format changed.
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
    booking.slotId = targetSlotId; // null if this was an ad-hoc time not tied to a listed slot
    booking.type = targetType;

    await kv.set('app-data', data);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
