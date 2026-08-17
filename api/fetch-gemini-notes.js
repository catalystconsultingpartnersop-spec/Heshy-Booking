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

function extractSummary(text) {
  const match = text.match(/Summary\s*\n([\s\S]*?)(?=\n\s*(?:Details|Transcript|Action items|Suggested next steps)\b|$)/i);
  const summary = match ? match[1].trim() : '';
  return summary || text.slice(0, 1500).trim();
}

function extractDurationMinutes(text) {
  const pattern = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g;
  let match;
  let minSeconds = Infinity;
  let maxSeconds = -Infinity;
  while ((match = pattern.exec(text)) !== null) {
    let seconds;
    if (match[3] !== undefined) {
      seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    } else {
      seconds = Number(match[1]) * 60 + Number(match[2]);
    }
    if (seconds < minSeconds) minSeconds = seconds;
    if (seconds > maxSeconds) maxSeconds = seconds;
  }
  if (!isFinite(minSeconds) || !isFinite(maxSeconds) || maxSeconds <= minSeconds) return null;
  return Math.max(1, Math.round((maxSeconds - minSeconds) / 60));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { bookingId } = req.body || {};
    const data = await kv.get('app-data');
    if (!data) return res.status(404).json({ error: 'No data found' });

    const booking = data.bookings.find(b => b.id === bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.calendarEventId) return res.status(400).json({ error: 'No calendar event linked to this session.' });

    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return res.status(400).json({ error: 'Google Calendar is not connected.' });

    const evRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const event = await evRes.json();
    if (!event.attachments || event.attachments.length === 0) {
      return res.status(404).json({ error: 'No notes found on the calendar event yet. Gemini usually takes a few minutes after the call ends.' });
    }

    const docAttachment = event.attachments.find(a => a.mimeType === 'application/vnd.google-apps.document');
    if (!docAttachment || !docAttachment.fileId) {
      return res.status(404).json({ error: 'No notes document found on this event yet.' });
    }

    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${docAttachment.fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!exportRes.ok) {
      const errBody = await exportRes.text().catch(() => '');
      return res.status(400).json({ error: `Google said: ${exportRes.status} — ${errBody.slice(0, 300)}` });
    }
    const text = await exportRes.text();

    const summary = extractSummary(text);
    const duration = extractDurationMinutes(text);

    booking.summary = summary;
    if (duration) booking.actualMinutes = duration;

    await kv.set('app-data', data);
    res.status(200).json({ ok: true, summary, actualMinutes: duration || booking.actualMinutes || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
