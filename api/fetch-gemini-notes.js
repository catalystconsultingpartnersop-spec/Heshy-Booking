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

function extractMeetingCode(meetLink) {
  if (!meetLink) return null;
  const parts = meetLink.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

async function fetchActualDurationFromMeet(accessToken, meetLink) {
  const meetingCode = extractMeetingCode(meetLink);
  if (!meetingCode) return { minutes: null, reason: 'No meeting link on this booking.' };
  try {
    const filter = encodeURIComponent(`space.meeting_code = "${meetingCode}"`);
    const r = await fetch(`https://meet.googleapis.com/v2/conferenceRecords?filter=${filter}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { minutes: null, reason: `Meet API error (${r.status}): ${body.slice(0, 200)}` };
    }
    const data = await r.json();
    const record = (data.conferenceRecords || [])[0];
    if (!record) return { minutes: null, reason: 'No Google Meet conference record found yet — it can take a few minutes to appear after the call ends.' };
    if (!record.startTime || !record.endTime) return { minutes: null, reason: 'The call may still be in progress, or the record is incomplete.' };
    const mins = Math.max(1, Math.round((new Date(record.endTime) - new Date(record.startTime)) / 60000));
    return { minutes: mins, reason: null };
  } catch (e) {
    return { minutes: null, reason: 'Could not reach the Meet API: ' + e.message };
  }
}

// Notes come from the recording pipeline now (Whisper + AI summary), not Gemini — this endpoint
// only confirms the real call duration from Google's own conference record.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { bookingId } = req.body || {};
    const data = await kv.get('app-data');
    if (!data) return res.status(404).json({ error: 'No data found' });

    const booking = data.bookings.find(b => b.id === bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.meetLink) return res.status(400).json({ error: 'No meeting link on this booking.' });

    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return res.status(400).json({ error: 'Google Calendar is not connected.' });

    const { minutes: meetMinutes, reason } = await fetchActualDurationFromMeet(accessToken, booking.meetLink);
    const hadManualDuration = booking.actualMinutes != null;
    let note;
    if (meetMinutes) {
      booking.actualMinutes = meetMinutes; // Google's own record is authoritative; safe to override the timer.
      note = `Duration confirmed by Google Meet: ${meetMinutes} min.`;
    } else {
      note = reason || 'Could not confirm duration from Google Meet.';
      note += hadManualDuration ? ` Keeping your timer's ${booking.actualMinutes} min for now.` : ' Use the Start/Stop timer to track actual time until this becomes available.';
    }

    await kv.set('app-data', data);
    res.status(200).json({
      ok: true,
      foundDuration: !!meetMinutes,
      actualMinutes: booking.actualMinutes || null,
      note
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
