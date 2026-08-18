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
          // 410 Gone means it was already deleted — that's fine, not an error.
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
